import { useCallback, useState } from "react";
import type { CatalogFilters } from "../api/catalog";

const SCROLL_KEY = "cf-models.catalogScroll";

export const DEFAULT_FILTERS: CatalogFilters = {
  search: "",
  tasks: [],
  authors: [],
  hostingFilter: "all",
  sort: "name",
}

/**
 * Catalog filters, held above the route so they survive opening a model and
 * coming back. They intentionally live only in React state, so a full page
 * refresh starts with a clean catalog.
 */
export function useFilters() {
  const [filters, setFilters] = useState<CatalogFilters>(() => ({ ...DEFAULT_FILTERS }));

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
