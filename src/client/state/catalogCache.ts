import type { Model } from "../../shared/types";

/**
 * Caches the catalog the app fetched from Cloudflare.
 *
 * This is a cache of live API data, never a substitute for it: entries expire,
 * carry a schema version, and are always revalidated against the API in the
 * background. Nothing here is a fallback list of models — a cold cache simply
 * means waiting for the fetch.
 */

const KEY_PREFIX = "cf-models.catalog.";
const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Bump when the shape of a cached Model changes, or when a loader bug means
 * previously cached data was wrong. Old entries are then ignored rather than
 * served. v2: the paginated loader; v1 could silently truncate the catalog.
 */
const CACHE_VERSION = 2;

interface CacheEntry {
  version: number;
  fetchedAt: number;
  models: Model[];
}

/** Scoped per account, so switching credentials never serves the wrong catalog. */
function keyFor(accountId: string): string {
  return `${KEY_PREFIX}${accountId}`;
}

export interface CachedCatalog {
  models: Model[];
  fetchedAt: number;
  stale: boolean;
}

export function readCatalogCache(accountId: string): CachedCatalog | null {
  try {
    const raw = localStorage.getItem(keyFor(accountId));
    if (!raw) return null;

    const entry = JSON.parse(raw) as CacheEntry;
    if (entry.version !== CACHE_VERSION || !Array.isArray(entry.models) || !entry.models.length) {
      return null;
    }
    return {
      models: entry.models,
      fetchedAt: entry.fetchedAt,
      stale: Date.now() - entry.fetchedAt > TTL_MS,
    };
  } catch {
    return null;
  }
}

export function writeCatalogCache(accountId: string, models: Model[]): void {
  if (!models.length) return;
  try {
    const entry: CacheEntry = {
      version: CACHE_VERSION,
      fetchedAt: Date.now(),
      // `raw` holds the full upstream payload and is only used for debugging;
      // dropping it keeps the entry small enough for localStorage.
      models: models.map((model) => ({ ...model, raw: null })),
    };
    localStorage.setItem(keyFor(accountId), JSON.stringify(entry));
  } catch {
    // Quota exceeded or storage disabled — the app works fine uncached.
  }
}

export function clearCatalogCache(accountId?: string): void {
  try {
    if (accountId) {
      localStorage.removeItem(keyFor(accountId));
      return;
    }
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(KEY_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    /* ignore */
  }
}

/** "3 minutes ago" — for the freshness indicator next to the refresh button. */
export function describeAge(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
