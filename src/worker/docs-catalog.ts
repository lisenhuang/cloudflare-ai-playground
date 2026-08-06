/**
 * Third-party models as a live secondary catalog source.
 *
 * Cloudflare's public `/ai/models/search` API only ever returns Workers AI models.
 * The authenticated account catalog supplies pricing for the third-party models
 * available to an account, while the official model docs fill out the broader
 * public list of models runnable through `/ai/run`.
 *
 * Cloudflare publishes that list on its own docs site, where each model is a
 * cell carrying structured data attributes. This fetches and parses that page
 * server-side (the browser could not, for CORS reasons) so the catalog stays
 * live rather than checked in. It is a real fetch of Cloudflare's own data on
 * every cache miss — not a hardcoded list.
 *
 * Caveat, deliberately loud: this parses HTML, so a markup change upstream
 * breaks it. It must fail soft — callers treat an empty result as "no extra
 * models", never as an error worth blocking the catalog for.
 */

export const DOCS_CATALOG_URL = "https://developers.cloudflare.com/ai/models/";

export interface DocsModel {
  /** Mimics the API's default shape so one normalizer handles both. */
  name: string;
  description: string;
  task: { name: string };
  tags: string[];
  provider: string;
}

/** Minimal entity decoding — the docs escape quotes and ampersands. */
function decodeEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function attr(tag: string, name: string): string {
  const match = tag.match(new RegExp(`\\sdata-${name}="([^"]*)"`));
  return match ? decodeEntities(match[1]).trim() : "";
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/**
 * Parses model cells out of the docs page.
 *
 * Anchored on the `data-models-cell` marker and its `data-*` attributes rather
 * than on styling classes, which change far more often.
 */
export function parseDocsCatalog(html: string): DocsModel[] {
  const models: DocsModel[] = [];
  const seen = new Set<string>();

  // Each cell runs until the next one begins.
  const cellPattern = /<div data-models-cell([^>]*)>/g;
  const starts: Array<{ tag: string; index: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = cellPattern.exec(html)) !== null) {
    starts.push({ tag: match[0], index: match.index, end: cellPattern.lastIndex });
  }

  for (let i = 0; i < starts.length; i++) {
    const { tag, end } = starts[i];
    const body = html.slice(end, starts[i + 1]?.index ?? end + 4000);

    const name = attr(tag, "name");
    if (!name || !name.includes("/") || seen.has(name)) continue;
    seen.add(name);

    // The first paragraph in a cell is the model blurb.
    const paragraph = body.match(/<p[^>]*>([\s\S]*?)<\/p>/);

    const capabilities = attr(tag, "facet-capabilities");
    const provider = attr(tag, "facet-providers");

    models.push({
      name,
      description: paragraph ? stripTags(paragraph[1]) : "",
      task: { name: attr(tag, "facet-tasks") || "Other" },
      tags: capabilities ? capabilities.split(/\s*,\s*/).filter(Boolean) : [],
      provider,
    });
  }

  return models;
}

/**
 * Fetches and parses the published catalog.
 *
 * Returns an empty list on any failure — a broken secondary source must never
 * take down the primary one.
 */
export async function fetchDocsCatalog(): Promise<DocsModel[]> {
  try {
    const response = await fetch(DOCS_CATALOG_URL, {
      headers: { "User-Agent": "cf-models-playground" },
      // Cached at the edge; this page changes only when Cloudflare ships models.
      cf: { cacheTtl: 3600, cacheEverything: true },
    } as RequestInit);
    if (!response.ok) return [];
    return parseDocsCatalog(await response.text());
  } catch {
    return [];
  }
}
