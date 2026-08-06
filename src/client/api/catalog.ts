import type { Credentials, Model } from "../../shared/types";
import { fetchCatalog } from "./client";
import { buildPriceIndex, extractItems, extractPageInfo, normalizeModel } from "./normalize";

const PAGE_SIZE = 100;
const MAX_PAGES = 20; // 2,000 models — a backstop, not an expected limit.

/**
 * Loads the entire catalog once, then filters and sorts in memory.
 *
 * The catalog is small (a couple of hundred models) and holding all of it makes
 * search, faceting and — crucially — sorting by price instant and correct.
 * Server-side pagination cannot sort by a field it does not rank on.
 */
export async function loadAllModels(creds: Credentials): Promise<Model[]> {
  // Pricing first, so every model can be priced as it is normalized.
  const priceIndex = await loadPriceIndex(creds);

  const models: Model[] = [];
  const seen = new Set<string>();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const payload = await fetchCatalog(creds, { page, perPage: PAGE_SIZE });
    const items = extractItems(payload);
    if (!items.length) break;

    for (const item of items) {
      const model = normalizeModel(item, priceIndex);
      if (model && !seen.has(model.id)) {
        seen.add(model.id);
        models.push(model);
      }
    }

    const info = extractPageInfo(payload);
    const total = info.total;
    if (items.length < PAGE_SIZE) break;
    if (total !== undefined && models.length >= total) break;
  }

  return models;
}

/**
 * Fetches the OpenRouter-format catalog purely for its pricing data.
 *
 * A failure here is not fatal: pricing degrades to the catalog's own metadata,
 * and then to "not published". Never to a guess.
 */
async function loadPriceIndex(creds: Credentials) {
  try {
    const payload = await fetchCatalog(creds, { format: "openrouter", perPage: 1000, page: 1 });
    return buildPriceIndex(payload);
  } catch {
    return undefined;
  }
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
