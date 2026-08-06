import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError, Credentials, Model } from "../../shared/types";
import { loadAllModels } from "../api/catalog";
import { RequestFailed } from "../api/client";
import { readCatalogCache, writeCatalogCache } from "./catalogCache";

interface CatalogState {
  models: Model[];
  /** True only when there is nothing to show yet. */
  loading: boolean;
  /** True while refreshing behind already-visible data. */
  revalidating: boolean;
  error: ApiError | null;
  /** When the visible data was fetched from Cloudflare. */
  fetchedAt: number | null;
  reload: () => void;
}

/**
 * Loads the catalog from Cloudflare, with stale-while-revalidate caching.
 *
 * A warm cache paints instantly and is then refreshed from the API in the
 * background, so the list is never stale for long and never hardcoded. A cold
 * cache just shows the loading state.
 */
export function useCatalog(creds: Credentials | null): CatalogState {
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(false);
  const [revalidating, setRevalidating] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  const forced = useRef(false);

  const reload = useCallback(() => {
    forced.current = true;
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!creds) {
      setModels([]);
      setFetchedAt(null);
      return;
    }

    let cancelled = false;
    const bypassCache = forced.current;
    forced.current = false;

    const cached = bypassCache ? null : readCatalogCache(creds.accountId);
    if (cached) {
      setModels(cached.models);
      setFetchedAt(cached.fetchedAt);
      setError(null);
      setLoading(false);
      setRevalidating(true);
    } else {
      setLoading(true);
      setRevalidating(false);
    }

    loadAllModels(creds)
      .then((loaded) => {
        if (cancelled) return;
        setModels(loaded);
        setFetchedAt(Date.now());
        setError(null);
        writeCatalogCache(creds.accountId, loaded);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const apiError =
          err instanceof RequestFailed
            ? err.error
            : { status: 500, message: (err as Error).message ?? "Failed to load the catalog." };
        // A failed background refresh must not blank out data already on screen.
        if (cached) {
          setError({
            ...apiError,
            hint: `Showing the cached catalog instead. ${apiError.hint ?? ""}`.trim(),
          });
        } else {
          setError(apiError);
        }
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setRevalidating(false);
      });

    return () => {
      cancelled = true;
    };
  }, [creds, nonce]);

  return { models, loading, revalidating, error, fetchedAt, reload };
}

/** Minimal hash router — enough for three routes and real deep links. */
export function useHashRoute(): { name: "catalog" | "model" | "setup"; modelId?: string } {
  const parse = () => {
    const hash = window.location.hash.replace(/^#/, "");
    if (hash.startsWith("/m/")) {
      return { name: "model" as const, modelId: decodeURIComponent(hash.slice(3)) };
    }
    if (hash.startsWith("/setup")) return { name: "setup" as const };
    return { name: "catalog" as const };
  };

  const [route, setRoute] = useState(parse);

  useEffect(() => {
    const onChange = () => setRoute(parse());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  return route;
}

export function navigate(path: string): void {
  window.location.hash = path;
}
