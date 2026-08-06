import { Hono } from "hono";
import {
  accountUrl,
  accountsUrl,
  aiUrl,
  errorResponse,
  getApiToken,
  getCredentials,
  proxyTokenToCloudflare,
  proxyToCloudflare,
  ProxyError,
} from "./cf-proxy";
import { fetchDocsCatalog } from "./docs-catalog";

interface Env {
  ASSETS: { fetch: (req: Request) => Promise<Response> };
}

const app = new Hono<{ Bindings: Env }>();

/** GET /api/accounts — discovers accounts after OAuth consent. */
app.get("/api/accounts", async (c) => {
  try {
    const token = getApiToken(c);
    const query = new URLSearchParams({ per_page: "100" });
    return await proxyTokenToCloudflare(token, accountsUrl(query));
  } catch (err) {
    return errorResponse(err);
  }
});

/** Query params the catalog endpoint understands; anything else is dropped. */
const CATALOG_PARAMS = [
  "search",
  "task",
  "author",
  "page",
  "per_page",
  "hide_experimental",
  "include_deprecated",
  "source",
  "format",
] as const;

/**
 * GET /api/models — browse the catalog.
 *
 * Pass `format=openrouter` through to get the marketplace shape, which is where
 * normalized per-model pricing lives.
 */
app.get("/api/models", async (c) => {
  try {
    const creds = getCredentials(c);
    const query = new URLSearchParams();
    for (const key of CATALOG_PARAMS) {
      const value = c.req.query(key);
      if (value !== undefined && value !== "") query.set(key, value);
    }
    return await proxyToCloudflare(creds, aiUrl(creds, "models/search", query), { method: "GET" });
  } catch (err) {
    return errorResponse(err);
  }
});

/**
 * GET /api/catalog/models — Cloudflare's authenticated account catalog.
 *
 * Unlike `/ai/models/search`, this endpoint includes Unified Billing models and
 * their per-model pricing. It is still scoped to the visitor's own account and
 * token by the same proxy used for every other API request.
 */
app.get("/api/catalog/models", async (c) => {
  try {
    const creds = getCredentials(c);
    const query = new URLSearchParams();
    for (const key of ["page", "per_page"] as const) {
      const value = c.req.query(key);
      if (value !== undefined && value !== "") query.set(key, value);
    }
    return await proxyToCloudflare(creds, aiUrl(creds, "catalog/models", query), { method: "GET" });
  } catch (err) {
    return errorResponse(err);
  }
});

/** GET /api/billing/credit-balance — the visitor's AI Gateway credit balance. */
app.get("/api/billing/credit-balance", async (c) => {
  try {
    const creds = getCredentials(c);
    return await proxyToCloudflare(
      creds,
      accountUrl(creds, "ai-gateway/billing/credit-balance"),
      { method: "GET" },
    );
  } catch (err) {
    return errorResponse(err);
  }
});

/**
 * GET /api/catalog/docs — the models Cloudflare publishes but does not serve
 * through the public model-search or this account's catalog.
 *
 * Fetched and parsed server-side because the browser cannot reach the docs
 * origin. Needs no credentials: it is public information.
 */
app.get("/api/catalog/docs", async (c) => {
  const models = await fetchDocsCatalog();
  return c.json(
    { models, count: models.length },
    200,
    { "Cache-Control": "public, max-age=3600" },
  );
});

/** GET /api/schema?model=... — the input/output JSON Schema that drives the form. */
app.get("/api/schema", async (c) => {
  try {
    const creds = getCredentials(c);
    const model = c.req.query("model");
    if (!model) throw new ProxyError(400, "Missing `model` query parameter.");

    const query = new URLSearchParams({ model });
    return await proxyToCloudflare(creds, aiUrl(creds, "models/schema", query), { method: "GET" });
  } catch (err) {
    return errorResponse(err);
  }
});

/**
 * POST /api/run — run any model in the catalog.
 *
 * Body: `{ model: string, input: object }`.
 *
 * Routing rules, because one size does not quite fit all:
 *   - With a gateway ID, the unified `/ai/run` endpoint handles every model.
 *   - Without one, Workers AI models (`@cf/...`) fall back to the path-based
 *     `/ai/run/{model}` form, which needs no gateway.
 *   - Third-party models always use the unified endpoint.
 */
app.post("/api/run", async (c) => {
  try {
    const creds = getCredentials(c);
    const body = await c.req.json<{ model?: string; input?: unknown }>().catch(() => null);
    if (!body?.model || typeof body.model !== "string") {
      throw new ProxyError(400, "Request body must include a `model` string.");
    }
    const input = body.input ?? {};
    const isCloudflareHosted = body.model.startsWith("@cf/");
    const useUnified = Boolean(creds.gatewayId) || !isCloudflareHosted;

    const url = useUnified
      ? aiUrl(creds, "run")
      : aiUrl(creds, `run/${body.model.replace(/^\/+/, "")}`);
    const payload = useUnified ? { model: body.model, input } : input;

    return await proxyToCloudflare(creds, url, {
      method: "POST",
      body: JSON.stringify(payload),
      contentType: "application/json",
      gateway: useUnified,
    });
  } catch (err) {
    return errorResponse(err);
  }
});

/**
 * ALL /api/cf/* — scoped passthrough to `/accounts/{id}/ai/*`.
 *
 * Used for polling queued jobs (video, music) whose exact endpoint shape is
 * pinned by `scripts/probe.mjs`. Restricted to the `ai` namespace of the
 * caller's own account, authenticated with the caller's own token.
 */
app.on(["GET", "POST"], "/api/cf/*", async (c) => {
  try {
    const creds = getCredentials(c);
    const path = c.req.path.replace(/^\/api\/cf\/?/, "");
    if (!path || path.includes("..")) throw new ProxyError(400, "Invalid passthrough path.");

    const url = new URL(c.req.url);
    const target = aiUrl(creds, path, url.searchParams);
    const method = c.req.method;
    const body = method === "POST" ? await c.req.text() : undefined;

    return await proxyToCloudflare(creds, target, {
      method,
      body,
      contentType: method === "POST" ? "application/json" : undefined,
      gateway: true,
    });
  } catch (err) {
    return errorResponse(err);
  }
});

app.all("/api/*", (c) => c.json({ success: false, error: { status: 404, message: "No such API route." } }, 404));

// Anything that is not /api/* is the React app, served from static assets.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
