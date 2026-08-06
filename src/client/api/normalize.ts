import type { Model, PriceEntry } from "../../shared/types";
import { PriceIndex, priceFromOpenRouter, resolvePrice } from "../pricing/resolve";

/**
 * The catalog API has more than one response shape (default vs. the OpenRouter
 * marketplace format), and field names are not fully specified in public docs.
 * Everything here is written to degrade gracefully rather than assume — run
 * `npm run probe` against a real account to see the exact shapes.
 */

type Dict = Record<string, unknown>;

function asDict(value: unknown): Dict | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Dict) : null;
}

function pickString(source: Dict, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function toNumber(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}

/** The identifier used when calling `/ai/run` — the one field we cannot guess wrong. */
export function extractId(raw: unknown): string | undefined {
  const item = asDict(raw);
  if (!item) return undefined;
  const candidates = [item.name, item.id, item.model, item.model_id];
  // A model id always contains a slash; a bare UUID `id` field does not.
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.includes("/")) return candidate.trim();
  }
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function splitId(id: string): { author: string; displayName: string; cloudflareHosted: boolean } {
  const cloudflareHosted = id.startsWith("@cf/");
  const body = cloudflareHosted ? id.slice("@cf/".length) : id;
  const segments = body.split("/").filter(Boolean);
  const displayName = segments[segments.length - 1] ?? id;
  const author = segments.length > 1 ? segments[0] : cloudflareHosted ? "cloudflare" : "unknown";
  return { author, displayName, cloudflareHosted };
}

function extractTask(item: Dict): string {
  const task = item.task;
  const dict = asDict(task);
  if (dict) {
    const name = pickString(dict, ["name", "id"]);
    if (name) return name;
  }
  if (typeof task === "string" && task.trim()) return task.trim();

  const direct = pickString(item, ["task_name", "type", "category"]);
  if (direct) return direct;

  // OpenRouter format describes capability as a modality like `text->image`.
  const architecture = asDict(item.architecture);
  const modality = architecture ? pickString(architecture, ["modality"]) : undefined;
  if (modality) {
    const MODALITIES: Record<string, string> = {
      "text->text": "Text Generation",
      "text+image->text": "Image-to-Text",
      "image->text": "Image-to-Text",
      "text->image": "Text-to-Image",
      "image->image": "Image-to-Image",
      "text+image->image": "Image-to-Image",
      "text->video": "Text-to-Video",
      "image->video": "Image-to-Video",
      "text+image->video": "Image-to-Video",
      "text->audio": "Text-to-Speech",
      "text->music": "Music Generation",
      "audio->text": "Automatic Speech Recognition",
      "text->embedding": "Text Embeddings",
    };
    return MODALITIES[modality] ?? modality;
  }
  return "Other";
}

/** Capability chips. Sources vary, so collect from everywhere and de-duplicate. */
function extractTags(item: Dict, cloudflareHosted: boolean): string[] {
  const tags = new Set<string>();

  for (const key of ["tags", "capabilities"]) {
    const value = item[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim()) tags.add(entry.trim());
      else {
        const dict = asDict(entry);
        const name = dict ? pickString(dict, ["name", "id", "value"]) : undefined;
        if (name) tags.add(name);
      }
    }
  }

  // Boolean-ish properties double as capability flags.
  const properties = item.properties;
  if (Array.isArray(properties)) {
    const FLAGS: Record<string, string> = {
      beta: "Beta",
      function_calling: "Function calling",
      lora: "LoRA",
      batch: "Batch",
      vision: "Vision",
      reasoning: "Reasoning",
      streaming: "Streaming",
      async_queue: "Async",
    };
    for (const property of properties) {
      const dict = asDict(property);
      if (!dict) continue;
      const id = String(dict.property_id ?? dict.id ?? "").toLowerCase();
      const label = FLAGS[id];
      if (label && String(dict.value).toLowerCase() === "true") tags.add(label);
    }
  }

  tags.add(cloudflareHosted ? "Cloudflare-hosted" : "Third-party");
  return [...tags];
}

function extractContextWindow(item: Dict): number | undefined {
  const direct = toNumber(item.context_length ?? item.context_window ?? item.max_input_tokens);
  if (direct) return direct;

  const properties = item.properties;
  if (Array.isArray(properties)) {
    for (const property of properties) {
      const dict = asDict(property);
      if (!dict) continue;
      const id = String(dict.property_id ?? dict.id ?? "").toLowerCase();
      if (id === "context_window" || id === "max_input_tokens" || id === "max_total_tokens") {
        const value = toNumber(dict.value);
        if (value) return value;
      }
    }
  }
  return undefined;
}

export function normalizeModel(
  raw: unknown,
  marketplaceIndex?: PriceIndex,
  accountIndex?: PriceIndex,
): Model | null {
  const item = asDict(raw);
  if (!item) return null;
  const id = extractId(item);
  if (!id) return null;

  const { author, displayName, cloudflareHosted } = splitId(id);
  const tags = extractTags(item, cloudflareHosted);

  return {
    id,
    displayName,
    author,
    description: pickString(item, ["description", "summary"]) ?? "",
    task: extractTask(item),
    tags,
    contextWindow: extractContextWindow(item),
    thirdParty: !cloudflareHosted || tags.includes("Third-party") || tags.includes("Partner"),
    cloudflareHosted,
    pricing: resolvePrice(id, item, marketplaceIndex, accountIndex),
    raw,
  };
}

/** Pulls the model array out of whichever envelope the API used. */
export function extractItems(payload: unknown): unknown[] {
  const body = asDict(payload);
  if (!body) return [];
  if (Array.isArray(body.result)) return body.result;
  if (Array.isArray(body.data)) return body.data;
  const result = asDict(body.result);
  if (result && Array.isArray(result.models)) return result.models;
  return [];
}

/** Reads pagination metadata, when the response carries any. */
export function extractPageInfo(payload: unknown): { page?: number; perPage?: number; total?: number } {
  const body = asDict(payload);
  const info = body ? asDict(body.result_info) : null;
  if (!info) return {};
  return {
    page: toNumber(info.page),
    perPage: toNumber(info.per_page),
    total: toNumber(info.total_count ?? info.count),
  };
}

/** Builds a price index from already-collected catalog items. */
export function buildPriceIndexFromItems(
  items: unknown[],
  extractPricing: (item: unknown) => PriceEntry[] = (item) => {
    const record = asDict(item);
    return priceFromOpenRouter(record?.pricing);
  },
): PriceIndex {
  const index = new PriceIndex();
  for (const raw of items) {
    const item = asDict(raw);
    if (!item) continue;
    const id = extractId(item);
    if (!id) continue;
    index.add(id, extractPricing(item));
  }
  return index;
}

/** Builds the price index from a raw OpenRouter-format catalog response. */
export function buildPriceIndex(payload: unknown): PriceIndex {
  return buildPriceIndexFromItems(extractItems(payload));
}
