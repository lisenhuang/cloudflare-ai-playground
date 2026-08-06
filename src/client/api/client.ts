import { CRED_HEADERS, type ApiError, type Credentials, type ModelSchema } from "../../shared/types";

export class RequestFailed extends Error {
  constructor(readonly error: ApiError) {
    super(error.message);
  }
}

function credHeaders(creds: Credentials): Record<string, string> {
  const headers: Record<string, string> = {
    [CRED_HEADERS.accountId]: creds.accountId,
    [CRED_HEADERS.apiToken]: creds.apiToken,
  };
  if (creds.gatewayId) headers[CRED_HEADERS.gatewayId] = creds.gatewayId;
  return headers;
}

/** Maps Cloudflare's error envelope onto something worth showing a person. */
async function toApiError(response: Response): Promise<ApiError> {
  let message = `Request failed with status ${response.status}.`;
  let code: number | undefined;
  let hint: string | undefined;

  try {
    const body = (await response.json()) as {
      error?: { message?: string; hint?: string };
      errors?: Array<{ message?: string; code?: number }>;
    };
    if (body?.error?.message) {
      message = body.error.message;
      hint = body.error.hint;
    } else if (Array.isArray(body?.errors) && body.errors.length) {
      message = body.errors.map((e) => e.message).filter(Boolean).join("; ") || message;
      code = body.errors[0]?.code;
    }
  } catch {
    /* non-JSON error body — keep the status-derived message */
  }

  // Cloudflare reports auth failures under more than one status code, so match
  // on the message too rather than trusting the status alone.
  const looksLikeAuth = /authenticat|unauthorized|invalid.*token|token.*invalid/i.test(message);

  if (response.status === 401 || looksLikeAuth) {
    hint ??=
      "Cloudflare rejected the credentials. Check the Account ID and token, and make sure the token has Workers AI → Edit.";
  } else if (response.status === 403) {
    hint ??= "The token is valid but lacks permission. It needs Workers AI → Edit on this account.";
  } else if (response.status === 429) {
    hint ??= "Rate limited by Cloudflare. Wait a moment and retry.";
  } else if (response.status === 402 || /insufficient balance|add money/i.test(message)) {
    // Third-party models are gated behind Unified Billing, not permissions.
    hint =
      "Third-party models are billed through AI Gateway Unified Billing. Add credits to your gateway, or configure BYOK with your own provider key. Cloudflare-hosted (@cf/…) models are unaffected.";
  }

  return { status: response.status, message, code, hint };
}

async function apiFetch(creds: Credentials, path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(path, {
    ...init,
    headers: { ...credHeaders(creds), ...(init?.headers as Record<string, string> | undefined) },
  });
  if (!response.ok) throw new RequestFailed(await toApiError(response));
  return response;
}

export interface CatalogQuery {
  search?: string;
  task?: string;
  author?: string;
  page?: number;
  perPage?: number;
  hideExperimental?: boolean;
  format?: "openrouter";
  /** Provider filter ("Source Id"); used to sweep every provider. */
  source?: number;
}

function toQueryString(query: CatalogQuery): string {
  const params = new URLSearchParams();
  if (query.search) params.set("search", query.search);
  if (query.task) params.set("task", query.task);
  if (query.author) params.set("author", query.author);
  if (query.page) params.set("page", String(query.page));
  if (query.perPage) params.set("per_page", String(query.perPage));
  if (query.hideExperimental) params.set("hide_experimental", "true");
  if (query.format) params.set("format", query.format);
  if (query.source !== undefined) params.set("source", String(query.source));
  return params.toString();
}

/** Raw catalog response — normalization happens in `api/normalize.ts`. */
export async function fetchCatalog(creds: Credentials, query: CatalogQuery): Promise<unknown> {
  const response = await apiFetch(creds, `/api/models?${toQueryString(query)}`);
  return response.json();
}

/**
 * Cloudflare's account catalog is richer than `/ai/models/search`: it includes
 * the authenticated Unified Billing catalog and per-model pricing.
 */
export async function fetchBillingCatalog(creds: Credentials, query: CatalogQuery): Promise<unknown> {
  const response = await apiFetch(creds, `/api/catalog/models?${toQueryString(query)}`);
  return response.json();
}

export interface CreditBalance {
  balance: number;
  hasDefaultPaymentMethod: boolean;
}

/** Reads the current AI Gateway credit balance for the connected account. */
export async function fetchCreditBalance(creds: Credentials): Promise<CreditBalance> {
  try {
    const response = await apiFetch(creds, "/api/billing/credit-balance");
    const body = (await response.json()) as {
      result?: { balance?: unknown; has_default_payment_method?: unknown };
    };
    const result = body.result;
    const rawBalance = result?.balance;
    const balance =
      typeof rawBalance === "number"
        ? rawBalance
        : typeof rawBalance === "string" && rawBalance.trim() !== ""
          ? Number(rawBalance)
          : Number.NaN;
    if (!Number.isFinite(balance)) {
      throw new RequestFailed({
        status: 502,
        message: "Cloudflare returned no usable AI Gateway credit balance.",
        hint: "Check that the API token has AI Gateway → Read permission.",
      });
    }
    return {
      balance,
      hasDefaultPaymentMethod: result?.has_default_payment_method === true,
    };
  } catch (err) {
    if (err instanceof RequestFailed && (err.error.status === 401 || err.error.status === 403)) {
      throw new RequestFailed({
        ...err.error,
        hint: "This token needs AI Gateway → Read permission to show the credit balance.",
      });
    }
    throw err;
  }
}

export async function fetchModelSchema(creds: Credentials, model: string): Promise<ModelSchema> {
  const response = await apiFetch(creds, `/api/schema?model=${encodeURIComponent(model)}`);
  const body = (await response.json()) as { result?: ModelSchema } & Partial<ModelSchema>;
  // Tolerate both `{result:{input,output}}` and a bare `{input,output}`.
  const schema = body.result ?? (body as ModelSchema);
  if (!schema?.input) {
    throw new RequestFailed({
      status: 502,
      message: "Cloudflare returned no input schema for this model.",
      hint: "You can still run it using the raw JSON editor.",
    });
  }
  return { input: schema.input, output: schema.output };
}

/** Cost and latency Cloudflare reports for a completed inference call. */
export interface RunTelemetry {
  costUsd?: number;
  latencyMs?: number;
  cacheStatus?: string;
}

function readTelemetry(headers: Headers): RunTelemetry {
  const cost = Number(headers.get("cf-aig-cost"));
  const latency = Number(headers.get("cf-aig-latency"));
  return {
    costUsd: Number.isFinite(cost) && headers.get("cf-aig-cost") !== null ? cost : undefined,
    latencyMs: Number.isFinite(latency) && headers.get("cf-aig-latency") !== null ? latency : undefined,
    cacheStatus: headers.get("cf-aig-cache-status") ?? undefined,
  };
}

export interface RunResult {
  /** How the body should be interpreted by the output renderer. */
  kind: "json" | "binary" | "stream";
  contentType: string;
  json?: unknown;
  blob?: Blob;
  stream?: ReadableStream<Uint8Array>;
  telemetry: RunTelemetry;
  elapsedMs: number;
}

/**
 * Runs a model. Streaming responses are handed back unconsumed so the caller
 * can render tokens as they arrive; binary responses (images, audio, video)
 * come back as a Blob.
 */
export async function runModel(
  creds: Credentials,
  model: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<RunResult> {
  const startedAt = performance.now();
  const response = await apiFetch(creds, "/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input }),
    signal,
  });

  const contentType = response.headers.get("content-type") ?? "";
  const telemetry = readTelemetry(response.headers);
  const elapsedMs = performance.now() - startedAt;

  if (contentType.includes("text/event-stream")) {
    return { kind: "stream", contentType, stream: response.body ?? undefined, telemetry, elapsedMs };
  }
  if (contentType.includes("application/json")) {
    return { kind: "json", contentType, json: await response.json(), telemetry, elapsedMs };
  }
  return { kind: "binary", contentType, blob: await response.blob(), telemetry, elapsedMs };
}

/** Polls a queued job (video, music) via the scoped passthrough route. */
export async function pollQueuedJob(
  creds: Credentials,
  model: string,
  requestId: string,
): Promise<unknown> {
  const path = `/api/cf/run/${model.replace(/^\/+/, "")}?request_id=${encodeURIComponent(requestId)}`;
  const response = await apiFetch(creds, path);
  return response.json();
}

/** Cheap credential check used by the setup screen. */
export async function verifyCredentials(creds: Credentials): Promise<void> {
  await fetchCatalog(creds, { perPage: 1, page: 1 });
}
