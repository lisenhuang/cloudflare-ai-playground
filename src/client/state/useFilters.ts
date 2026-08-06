import { useCallback, useEffect, useState } from "react";
import type { CatalogFilters } from "../api/catalog";

const STORAGE_KEY = "cf-models.filters";
const SCROLL_KEY = "cf-models.catalogScroll";

export const DEFAULT_FILTERS: CatalogFilters = {
  search: "",
  tasks: [],
  authors: [],
  hostingFilter: "all",
  sort: "name",
};

function read(): CatalogFilters {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_FILTERS;
    const parsed = JSON.parse(raw) as Partial<CatalogFilters>;
    return {
      search: typeof parsed.search === "string" ? parsed.search : "",
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks.filter((t) => typeof t === "string") : [],
      authors: Array.isArray(parsed.authors) ? parsed.authors.filter((a) => typeof a === "string") : [],
      hostingFilter:
        parsed.hostingFilter === "cloudflare" || parsed.hostingFilter === "third-party"
          ? parsed.hostingFilter
          : "all",
      sort: parsed.sort ?? "name",
    };
  } catch {
    return DEFAULT_FILTERS;
  }
}

/**
 * Catalog filters, held above the route so they survive opening a model and
 * coming back. Persisted to sessionStorage so a reload keeps your place too,
 * without leaking filter state into a new tab or a later session.
 */
export function useFilters() {
  const [filters, setFilters] = useState<CatalogFilters>(read);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
    } catch {
      /* storage unavailable — filters still work for this view */
    }
  }, [filters]);

  const update = useCallback(
    (patch: Partial<CatalogFilters>) => setFilters((current) => ({ ...current, ...patch })),
    [],
  );

  const reset = useCallback(() => setFilters(DEFAULT_FILTERS), []);

  return { filters, update, reset };
}

export function saveCatalogScroll(offset: number): void {
  try {
    sessionStorage.setItem(SCROLL_KEY, String(offset));
  } catch {
    /* ignore */
  }
}

export function takeCatalogScroll(): number {
  try {
    const raw = sessionStorage.getItem(SCROLL_KEY);
    return raw ? Number(raw) || 0 : 0;
  } catch {
    return 0;
  }
}
