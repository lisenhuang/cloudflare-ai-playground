#!/usr/bin/env node
/**
 * Dumps raw Cloudflare AI API responses so the exact field names can be pinned
 * against reality rather than guessed from docs.
 *
 *   CF_ACCOUNT_ID=... CF_API_TOKEN=... npm run probe
 *
 * Writes to .probe/ (gitignored) and prints a summary of where pricing, task
 * type and capability data actually live in the payloads.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const accountId = process.env.CF_ACCOUNT_ID;
const apiToken = process.env.CF_API_TOKEN;
const gatewayId = process.env.CF_GATEWAY_ID;

if (!accountId || !apiToken) {
  console.error("Set CF_ACCOUNT_ID and CF_API_TOKEN, then re-run.\n");
  console.error("  CF_ACCOUNT_ID=xxx CF_API_TOKEN=yyy npm run probe");
  process.exit(1);
}

const BASE = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai`;
const OUT_DIR = resolve(process.cwd(), ".probe");

async function call(label, path, init = {}) {
  const url = `${BASE}/${path}`;
  process.stdout.write(`→ ${label} … `);
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(gatewayId ? { "cf-aig-gateway-id": gatewayId } : {}),
        ...init.headers,
      },
    });

    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("json") ? await response.json() : await response.text();
    console.log(`${response.status} ${contentType.split(";")[0]}`);

    await writeFile(
      resolve(OUT_DIR, `${label}.json`),
      typeof body === "string" ? body : JSON.stringify(body, null, 2),
    );
    return { status: response.status, body, headers: response.headers };
  } catch (error) {
    console.log(`failed — ${error.message}`);
    return null;
  }
}

function items(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.result)) return payload.result;
  if (Array.isArray(payload.data)) return payload.data;
  return [];
}

/**
 * Walks every page. Termination must not assume the server honours the
 * requested per_page — it caps at its own maximum, and treating a short page as
 * the end silently truncates the catalog.
 */
async function collectAll(label, query) {
  const all = [];
  for (let page = 1; page <= 50; page++) {
    const url = `models/search?${query}&per_page=100&page=${page}`;
    const response = await call(page === 1 ? label : `${label}-p${page}`, url);
    const batch = items(response?.body);
    if (!batch.length) break;
    all.push(...batch);

    const info = response?.body?.result_info ?? {};
    if (info.total_count !== undefined && all.length >= info.total_count) break;
    const serverPageSize = info.per_page ?? batch.length;
    if (batch.length < serverPageSize) break;
  }
  return all;
}

await mkdir(OUT_DIR, { recursive: true });

console.log("\nProbing the Cloudflare AI API\n");

// 1. Default catalog format — paginated to exhaustion.
const catalog = await call("models-search", "models/search?per_page=100&page=1");
const allDefault = await collectAll("models-search-all", "");

// 2. Marketplace format — the primary pricing source.
const marketplace = await call("models-search-openrouter", "models/search?format=openrouter&per_page=1000");
const allMarketplace = await collectAll("models-search-openrouter-all", "format=openrouter");

// 3. A model schema, using whichever model the catalog returned first.
const first = items(catalog?.body)[0];
const sampleId = first?.name ?? first?.id;
if (sampleId) {
  await call("model-schema", `models/schema?model=${encodeURIComponent(sampleId)}`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("\n─── Findings ───\n");

const catalogItems = items(catalog?.body);
console.log(`Models on page 1         : ${catalogItems.length}  (asked for 100)`);
console.log(`Server per_page cap      : ${catalog?.body?.result_info?.per_page ?? "not reported"}`);
const totalCount = catalog?.body?.result_info?.total_count;
if (totalCount !== undefined) console.log(`Total reported           : ${totalCount}`);
console.log(`Collected, default fmt   : ${allDefault.length}`);
console.log(`Collected, marketplace   : ${allMarketplace.length}`);

// The union is what the app actually shows.
const idOf = (m) => m.name ?? m.id ?? m.model;
const union = new Set([...allDefault, ...allMarketplace].map(idOf).filter(Boolean));
console.log(`Union (what the app gets): ${union.size}`);
if (totalCount !== undefined && union.size < totalCount) {
  console.log(`  ⚠ ${totalCount - union.size} models are NOT being collected.`);
}

// Task-type breakdown, directly comparable to the dashboard's filter dropdown.
const taskCounts = new Map();
for (const m of allDefault) {
  const task = m.task?.name ?? m.task ?? m.architecture?.modality ?? "(none)";
  taskCounts.set(task, (taskCounts.get(task) ?? 0) + 1);
}
console.log("\nTask types found (compare against the dashboard dropdown):");
for (const [task, count] of [...taskCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${task}`);
}
for (const expected of ["Text-to-Video", "Image-to-Video", "Music Generation"]) {
  if (![...taskCounts.keys()].some((t) => String(t).toLowerCase() === expected.toLowerCase())) {
    console.log(`  ⚠ "${expected}" is missing from the default catalog format.`);
  }
}

if (first) {
  console.log(`Top-level fields         : ${Object.keys(first).join(", ")}`);
  console.log(`Sample model id          : ${sampleId}`);
  if (Array.isArray(first.properties)) {
    const ids = first.properties.map((p) => p.property_id ?? p.id).filter(Boolean);
    console.log(`property_id values       : ${ids.join(", ") || "(none)"}`);
  } else {
    console.log("properties               : absent on this model");
  }
}

// Where does pricing actually live?
const pricedInCatalog = catalogItems.filter((item) =>
  (item.properties ?? []).some((p) => String(p.property_id ?? "").startsWith("price")),
).length;
const marketplaceItems = items(marketplace?.body);
const pricedInMarketplace = marketplaceItems.filter((item) => item.pricing).length;

console.log(`\nPricing via catalog properties   : ${pricedInCatalog}/${catalogItems.length}`);
console.log(`Pricing via openrouter format    : ${pricedInMarketplace}/${marketplaceItems.length}`);

const pricedSample = marketplaceItems.find((item) => item.pricing);
if (pricedSample) {
  console.log(`Sample pricing object            : ${JSON.stringify(pricedSample.pricing)}`);
}

// Does the unified /ai/run endpoint need a gateway id for Workers AI models?
console.log("\n─── Gateway requirement check ───\n");
const cfModel = catalogItems.find((item) => String(item.name ?? "").startsWith("@cf/"))?.name;
if (cfModel) {
  const probe = await call("run-unified-workersai", "run", {
    method: "POST",
    body: JSON.stringify({ model: cfModel, input: { prompt: "ping" } }),
  });
  console.log(
    probe?.status === 200
      ? `Unified /ai/run works for ${cfModel}${gatewayId ? " (with gateway)" : " WITHOUT a gateway id"}`
      : `Unified /ai/run returned ${probe?.status} for ${cfModel} — the path-based fallback is needed`,
  );
}

console.log(`\nRaw payloads written to ${OUT_DIR}\n`);
