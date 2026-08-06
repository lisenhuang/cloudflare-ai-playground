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

await mkdir(OUT_DIR, { recursive: true });

console.log("\nProbing the Cloudflare AI API\n");

// 1. Default catalog format.
const catalog = await call("models-search", "models/search?per_page=100&page=1");

// 2. Marketplace format — the primary pricing source.
const marketplace = await call("models-search-openrouter", "models/search?format=openrouter&per_page=1000");

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
console.log(`Catalog models on page 1 : ${catalogItems.length}`);
const totalCount = catalog?.body?.result_info?.total_count;
if (totalCount !== undefined) console.log(`Total reported           : ${totalCount}`);

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
