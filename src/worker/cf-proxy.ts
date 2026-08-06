import type { Context } from "hono";
import { CRED_HEADERS, type Credentials } from "../shared/types";

export const CF_API_BASE = "https://api.cloudflare.com/client/v4";

/**
 * Response headers worth returning to the browser. `cf-aig-*` carries the real
 * cost/latency of an inference call, which the UI reports per run.
 */
const PASSTHROUGH_PREFIXES = ["cf-aig-", "x-request-id", "cf-ray"];

export class ProxyError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

/**
 * Pulls the visitor's own Cloudflare credentials off the request.
 *
 * These are never persisted, cached or logged — they exist only for the
 * lifetime of the request they arrived on.
 */
export function getCredentials(c: Context): Credentials {
  const accountId = c.req.header(CRED_HEADERS.accountId)?.trim();
  const apiToken = getApiToken(c);
  const gatewayId = c.req.header(CRED_HEADERS.gatewayId)?.trim();

  if (!accountId || !apiToken) {
    throw new ProxyError(
      401,
      "Missing Cloudflare credentials.",
      "Add your Account ID and API token on the setup screen.",
    );
  }
  if (!/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new ProxyError(
      400,
      "That does not look like a Cloudflare Account ID.",
      "It is a 32-character hex string, visible in your dashboard URL.",
    );
  }
  return { accountId, apiToken, gatewayId: gatewayId || undefined };
}

/** Gets the bearer credential for account discovery before an account is known. */
export function getApiToken(c: Context): string {
  const apiToken = c.req.header(CRED_HEADERS.apiToken)?.trim();
  if (!apiToken) {
    throw new ProxyError(
      401,
      "Missing Cloudflare credentials.",
      "Sign in with Cloudflare or add an API token on the setup screen.",
    );
  }
  return apiToken;
}

function authHeaders(creds: Credentials, extra?: Record<string, string>): Headers {
  const headers = new Headers(extra);
  headers.set("Authorization", `Bearer ${creds.apiToken}`);
  return headers;
}

/** Copies the response headers we want the browser to be able to read. */
function forwardHeaders(from: Headers, to: Headers): void {
  from.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (PASSTHROUGH_PREFIXES.some((p) => lower.startsWith(p))) {
      to.set(key, value);
    }
  });
}

/** Builds `.../accounts/{id}/ai/{path}` with an optional query string. */
export function aiUrl(creds: Credentials, path: string, query?: URLSearchParams): string {
  const clean = path.replace(/^\/+/, "");
  const qs = query && [...query.keys()].length ? `?${query.toString()}` : "";
  return `${CF_API_BASE}/accounts/${creds.accountId}/ai/${clean}${qs}`;
}

/** Builds `.../accounts/{id}/{path}` for account-scoped APIs outside `/ai`. */
export function accountUrl(creds: Credentials, path: string, query?: URLSearchParams): string {
  const clean = path.replace(/^\/+/, "");
  const qs = query && [...query.keys()].length ? `?${query.toString()}` : "";
  return `${CF_API_BASE}/accounts/${creds.accountId}/${clean}${qs}`;
}

/** Builds an account-list URL, which is intentionally not account-scoped. */
export function accountsUrl(query?: URLSearchParams): string {
  const qs = query && [...query.keys()].length ? `?${query.toString()}` : "";
  return `${CF_API_BASE}/accounts${qs}`;
}

/**
 * Calls the Cloudflare AI API and returns the upstream response verbatim.
 *
 * The body is streamed rather than buffered so that SSE token streaming and
 * large binary payloads (images, audio, video) both pass through untouched.
 */
export async function proxyToCloudflare(
  creds: Credentials,
  url: string,
  init: { method: string; body?: BodyInit | null; contentType?: string; gateway?: boolean },
): Promise<Response> {
  const headers = authHeaders(creds);
  if (init.contentType) headers.set("Content-Type", init.contentType);
  // Required by the unified /ai/run endpoint for Workers AI models, optional otherwise.
  if (init.gateway && creds.gatewayId) headers.set("cf-aig-gateway-id", creds.gatewayId);

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: init.method,
      headers,
      body: init.body ?? null,
    });
  } catch (err) {
    throw new ProxyError(
      502,
      `Could not reach the Cloudflare API: ${(err as Error).message}`,
      "Check your network connection and try again.",
    );
  }

  const outHeaders = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) outHeaders.set("Content-Type", contentType);
  const disposition = upstream.headers.get("content-disposition");
  if (disposition) outHeaders.set("Content-Disposition", disposition);
  forwardHeaders(upstream.headers, outHeaders);
  // Same-origin, but be explicit so the client can read the cost headers.
  outHeaders.set(
    "Access-Control-Expose-Headers",
    "cf-aig-cost, cf-aig-latency, cf-aig-cache-status, x-request-id",
  );
  outHeaders.set("Cache-Control", "no-store");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: outHeaders,
  });
}

/** Proxies the account-list request used by OAuth before an account is selected. */
export async function proxyTokenToCloudflare(token: string, url: string): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    throw new ProxyError(
      502,
      `Could not reach the Cloudflare API: ${(err as Error).message}`,
      "Check your network connection and try again.",
    );
  }

  const outHeaders = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) outHeaders.set("Content-Type", contentType);
  outHeaders.set("Cache-Control", "no-store");
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

/** Turns any thrown error into the JSON envelope the client expects. */
export function errorResponse(err: unknown): Response {
  const isProxy = err instanceof ProxyError;
  const status = isProxy ? err.status : 500;
  const message = isProxy ? err.message : "Unexpected proxy error.";
  const hint = isProxy ? err.hint : undefined;

  return new Response(JSON.stringify({ success: false, error: { status, message, hint } }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
