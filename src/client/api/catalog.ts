import type { Credentials, Model } from "../../shared/types";
import { fetchCatalog, type CatalogQuery } from "./client";
import {
  buildPriceIndexFromItems,
  extractId,
  extractItems,
  extractPageInfo,
  normalizeModel,
} from "./normalize";

const PAGE_SIZE = 100;
const MAX_PAGES = 50; // Backstop against a server that never reports completion.

/**
 * Walks every page of one catalog query.
 *
 * Termination is deliberately NOT based on the page size we asked for: the API
 * caps `per_page` at its own maximum, so a short page relative to our request
 * is normal and does not mean the end of the list. Stopping on that assumption
 * silently truncated the catalog to a single page.
 */
async function fetchAllPages(creds: Credentials, base: CatalogQuery): Promise<unknown[]> {
  const collected: unknown[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const payload = await fetchCatalog(creds, { ...base, page, perPage: PAGE_SIZE });
    const items = extractItems(payload);
    if (!items.length) break;

    collected.push(...items);

    const info = extractPageInfo(payload);
    if (info.total !== undefined && collected.length >= info.total) break;

    // Compare against the server's own page size when it reports one; otherwise
    // keep going until a page comes back empty.
    const serverPageSize = info.perPage ?? items.length;
    if (items.length < serverPageSize) break;
  }

  return collected;
}

/** A pass over the catalog. A failing pass is skipped, never fatal. */
async function tryPass(creds: Credentials, base: CatalogQuery): Promise<unknown[]> {
  try {
    return await fetchAllPages(creds, base);
  } catch {
    return [];
  }
}

/**
 * Loads the entire catalog once, then filters and sorts in memory.
 *
 * Two passes are unioned so that no model is missed: the default format carries
 * the richer metadata (task object, description, capabilities), while the
 * marketplace format is the one that carries pricing — and the two do not
 * always cover exactly the same set. Union, then prefer the richer record.
 *
 * Holding the whole catalog also makes search, faceting and sorting by price
 * instant and correct; server-side pagination cannot rank on a field it does
 * not sort by.
 */
export async function loadAllModels(creds: Credentials): Promise<Model[]> {
  const [defaultItems, marketplaceItems] = await Promise.all([
    fetchAllPages(creds, {}),
    tryPass(creds, { format: "openrouter" }),
  ]);

  const priceIndex = buildPriceIndexFromItems(marketplaceItems);

  // Marketplace entries first, then default-format entries overwrite them —
  // last write wins, and the default format has the better metadata.
  const byId = new Map<string, unknown>();
  for (const item of [...marketplaceItems, ...defaultItems]) {
    const id = extractId(item);
    if (id) byId.set(id, item);
  }

  const models: Model[] = [];
  for (const item of byId.values()) {
    const model = normalizeModel(item, priceIndex);
    if (model) models.push(model);
  }
  return models;
}

export type SortOrder = "name" | "price-asc" | "price-desc" | "task";

export interface Facet {
  value: string;
  count: number;
}

/** Task-type and author facets with counts, mirroring the dashboard's filters. */
export function buildFacets(models: Model[]): { tasks: Facet[]; authors: Facet[] } {
  const tasks = new Map<string, number>();
  const authors = new Map<string, number>();

  for (const model of models) {
    tasks.set(model.task, (tasks.get(model.task) ?? 0) + 1);
    authors.set(model.author, (authors.get(model.author) ?? 0) + 1);
  }

  const toSorted = (map: Map<string, number>): Facet[] =>
    [...map.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

  return { tasks: toSorted(tasks), authors: toSorted(authors) };
}

export interface CatalogFilters {
  search: string;
  tasks: string[];
  authors: string[];
  hostingFilter: "all" | "cloudflare" | "third-party";
  sort: SortOrder;
}

export function filterModels(models: Model[], filters: CatalogFilters): Model[] {
  const needle = filters.search.trim().toLowerCase();
  const taskSet = new Set(filters.tasks);
  const authorSet = new Set(filters.authors);

  const matched = models.filter((model) => {
    if (taskSet.size && !taskSet.has(model.task)) return false;
    if (authorSet.size && !authorSet.has(model.author)) return false;
    if (filters.hostingFilter === "cloudflare" && !model.cloudflareHosted) return false;
    if (filters.hostingFilter === "third-party" && model.cloudflareHosted) return false;
    if (!needle) return true;
    return (
      model.id.toLowerCase().includes(needle) ||
      model.displayName.toLowerCase().includes(needle) ||
      model.description.toLowerCase().includes(needle) ||
      model.task.toLowerCase().includes(needle) ||
      model.author.toLowerCase().includes(needle)
    );
  });

  return sortModels(matched, filters.sort);
}

function sortModels(models: Model[], sort: SortOrder): Model[] {
  const sorted = [...models];
  switch (sort) {
    case "price-asc":
      return sorted.sort((a, b) => byPrice(a, b, 1));
    case "price-desc":
      return sorted.sort((a, b) => byPrice(a, b, -1));
    case "task":
      return sorted.sort(
        (a, b) => a.task.localeCompare(b.task) || a.displayName.localeCompare(b.displayName),
      );
    default:
      return sorted.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }
}

/** Unpriced models always sink to the bottom, whichever direction we sort. */
function byPrice(a: Model, b: Model, direction: 1 | -1): number {
  const keyA = priceKey(a);
  const keyB = priceKey(b);
  const aMissing = !Number.isFinite(keyA);
  const bMissing = !Number.isFinite(keyB);
  if (aMissing && bMissing) return a.displayName.localeCompare(b.displayName);
  if (aMissing) return 1;
  if (bMissing) return -1;
  return (keyA - keyB) * direction || a.displayName.localeCompare(b.displayName);
}

function priceKey(model: Model): number {
  const billable = model.pricing.entries.filter((e) => e.currency.toLowerCase() !== "neurons");
  if (!billable.length) return Number.POSITIVE_INFINITY;
  const input = billable.find((e) => /input token/i.test(e.unit));
  return input ? input.price : Math.min(...billable.map((e) => e.price));
}
