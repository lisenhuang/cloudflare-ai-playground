import type { PriceEntry, PriceInfo } from "../../shared/types";

/**
 * Pricing is always resolved from the Cloudflare API at runtime — never from a
 * table in this repo. Cloudflare's public pricing page documents only a subset
 * of the catalog, so any hardcoded list would be both stale and incomplete.
 *
 * Resolution order:
 *   1. `GET /ai/models/search?format=openrouter` — normalized token pricing that
 *      spans Cloudflare-hosted *and* third-party models.
 *   2. The default catalog response's own metadata — where non-token units
 *      (per image, per step, per audio minute) and neuron rates live.
 *   3. Nothing. A model with no published price renders as exactly that.
 */

const EMPTY: PriceInfo = { entries: [], source: "none" };

/** Public model pages link third-party pricing to this account-specific view. */
export function dashboardPricingUrl(id: string): string {
  const modelPath = id
    .replace(/^\/+/, "")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://dash.cloudflare.com/?to=/:account/ai/models/${modelPath}`;
}

/** OpenRouter expresses prices in USD per single unit, as strings. */
const OPENROUTER_UNITS: Record<string, { unit: string; perMillion: boolean }> = {
  prompt: { unit: "per M input tokens", perMillion: true },
  completion: { unit: "per M output tokens", perMillion: true },
  input_cache_read: { unit: "per M cached read tokens", perMillion: true },
  input_cache_write: { unit: "per M cached write tokens", perMillion: true },
  internal_reasoning: { unit: "per M reasoning tokens", perMillion: true },
  request: { unit: "per request", perMillion: false },
  image: { unit: "per image", perMillion: false },
  audio: { unit: "per audio unit", perMillion: false },
  web_search: { unit: "per web search", perMillion: false },
};

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Extracts price entries from an OpenRouter-format `pricing` object. */
export function priceFromOpenRouter(pricing: unknown): PriceEntry[] {
  if (!pricing || typeof pricing !== "object") return [];
  const entries: PriceEntry[] = [];
  let sawAnyKey = false;

  for (const [key, rawValue] of Object.entries(pricing as Record<string, unknown>)) {
    const meta = OPENROUTER_UNITS[key];
    if (!meta) continue;
    const value = toNumber(rawValue);
    if (value === null) continue;
    sawAnyKey = true;
    // A zero on an irrelevant axis (e.g. `image` for a text model) is noise.
    if (value === 0) continue;
    entries.push({
      unit: meta.unit,
      price: meta.perMillion ? value * 1_000_000 : value,
      currency: "USD",
    });
  }

  // Genuinely free models report zeros across the board — say so rather than
  // falling through to "not published".
  if (!entries.length && sawAnyKey) {
    return [{ unit: "per request", price: 0, currency: "USD" }];
  }
  return entries;
}

/**
 * Extracts price entries from a default-format catalog item.
 *
 * Cloudflare attaches these as a `properties` array of `{property_id, value}`
 * pairs whose `value` may be an object, an array, or a JSON-encoded string —
 * so every shape is handled.
 */
export function priceFromCatalogItem(item: unknown): PriceEntry[] {
  if (!item || typeof item !== "object") return [];
  const properties = (item as { properties?: unknown }).properties;
  if (!Array.isArray(properties)) return [];

  const entries: PriceEntry[] = [];
  for (const property of properties) {
    if (!property || typeof property !== "object") continue;
    const id = String(
      (property as Record<string, unknown>).property_id ?? (property as Record<string, unknown>).id ?? "",
    ).toLowerCase();
    if (!id.startsWith("price")) continue;

    let value: unknown = (property as Record<string, unknown>).value;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        continue; // an unparseable price string is not a price
      }
    }
    for (const candidate of Array.isArray(value) ? value : [value]) {
      if (!candidate || typeof candidate !== "object") continue;
      const record = candidate as Record<string, unknown>;
      const price = toNumber(record.price);
      if (price === null) continue;
      entries.push({
        unit: String(record.unit ?? "per request"),
        price,
        currency: String(record.currency ?? "USD"),
        neurons: toNumber(record.neurons) ?? undefined,
      });
    }
  }
  return entries;
}

/** Index of model id → pricing, built from the `format=openrouter` pass. */
export class PriceIndex {
  private readonly byId = new Map<string, PriceEntry[]>();

  /** Two keys per model: the exact id, and a loose last-segment fallback. */
  private static keysFor(id: string): string[] {
    const lower = id.toLowerCase();
    const tail = lower.split("/").pop() ?? lower;
    return tail && tail !== lower ? [lower, tail] : [lower];
  }

  add(id: string, entries: PriceEntry[]): void {
    if (!id || !entries.length) return;
    for (const key of PriceIndex.keysFor(id)) {
      if (!this.byId.has(key)) this.byId.set(key, entries);
    }
  }

  lookup(id: string): PriceEntry[] | undefined {
    for (const key of PriceIndex.keysFor(id)) {
      const found = this.byId.get(key);
      if (found) return found;
    }
    return undefined;
  }

  get size(): number {
    return this.byId.size;
  }
}

/** Applies the fallback chain for one model. */
export function resolvePrice(id: string, catalogItem: unknown, index?: PriceIndex): PriceInfo {
  const fromIndex = index?.lookup(id);
  if (fromIndex?.length) return { entries: fromIndex, source: "openrouter" };

  const fromCatalog = priceFromCatalogItem(catalogItem);
  if (fromCatalog.length) return { entries: fromCatalog, source: "catalog" };

  return EMPTY;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Formats a USD amount without inventing or rounding away precision. */
export function formatUsd(amount: number): string {
  if (amount === 0) return "$0";
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  const decimals = amount >= 0.001 ? 4 : 6;
  const text = amount.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
  return `$${text}`;
}

export function formatEntry(entry: PriceEntry): string {
  if (entry.currency.toLowerCase() === "neurons") {
    return `${entry.price.toLocaleString()} neurons ${entry.unit}`;
  }
  const amount = entry.currency === "USD" ? formatUsd(entry.price) : `${entry.price} ${entry.currency}`;
  return `${amount} ${entry.unit}`;
}

/** The one line shown on a catalog card. */
export function summarizePrice(info: PriceInfo): string | null {
  const billable = info.entries.filter((e) => e.currency.toLowerCase() !== "neurons");
  if (!billable.length) return null;
  if (billable.every((e) => e.price === 0)) return "Free";

  const input = billable.find((e) => /input token/i.test(e.unit));
  const output = billable.find((e) => /output token/i.test(e.unit));
  if (input && output) {
    return `${formatUsd(input.price)} in · ${formatUsd(output.price)} out /M tokens`;
  }
  return formatEntry(billable[0]);
}

/**
 * Comparable key for sorting by price. Models without a published price sort
 * last in both directions rather than masquerading as free.
 */
export function priceSortKey(info: PriceInfo): number {
  const billable = info.entries.filter((e) => e.currency.toLowerCase() !== "neurons");
  if (!billable.length) return Number.POSITIVE_INFINITY;
  const input = billable.find((e) => /input token/i.test(e.unit));
  return input ? input.price : Math.min(...billable.map((e) => e.price));
}
