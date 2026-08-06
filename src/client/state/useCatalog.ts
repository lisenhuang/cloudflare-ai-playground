import { useCallback, useEffect, useState } from "react";
import type { Credentials, Model } from "../../shared/types";
import { loadAllModels } from "../api/catalog";
import { RequestFailed } from "../api/client";
import type { ApiError } from "../../shared/types";

interface CatalogState {
  models: Model[];
  loading: boolean;
  error: ApiError | null;
  reload: () => void;
}

/** Loads the whole catalog once per credential set, then keeps it in memory. */
export function useCatalog(creds: Credentials | null): CatalogState {
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!creds) {
      setModels([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    loadAllModels(creds)
      .then((loaded) => {
        if (!cancelled) setModels(loaded);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof RequestFailed
            ? err.error
            : { status: 500, message: (err as Error).message ?? "Failed to load the catalog." },
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [creds, nonce]);

  return { models, loading, error, reload };
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
