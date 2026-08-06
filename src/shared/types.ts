/** Types shared between the Worker proxy and the React client. */

/** Cloudflare's own model catalog docs — the reference for every model listed here. */
export const CF_MODEL_CATALOG_URL = "https://developers.cloudflare.com/ai/models/";

/** Credentials the visitor supplies from the browser. Never stored server-side. */
export interface Credentials {
  accountId: string;
  apiToken: string;
  /** Optional. Required by the unified /ai/run endpoint for Workers AI models. */
  gatewayId?: string;
  /** OAuth credentials are refreshed in the browser when the access token expires. */
  authMethod?: "oauth" | "token";
  refreshToken?: string;
  expiresAt?: number;
}

/** Header names used to carry BYOK credentials from the browser to our proxy. */
export const CRED_HEADERS = {
  accountId: "x-cf-account-id",
  apiToken: "x-cf-token",
  gatewayId: "x-cf-gateway-id",
} as const;

/** A single price point, e.g. `$0.027 per M input tokens`. */
export interface PriceEntry {
  /** Human-readable unit exactly as the API expresses it. */
  unit: string;
  /** Price in `currency` for one `unit`. */
  price: number;
  currency: string;
  /** Cloudflare's neuron-denominated equivalent, when the API provides it. */
  neurons?: number;
}

export type PriceSource = "openrouter" | "catalog" | "none";

export interface PriceInfo {
  entries: PriceEntry[];
  source: PriceSource;
}

/** A model, normalized across the several shapes the catalog API can return. */
export interface Model {
  /** The exact identifier to pass as `model` when running inference. */
  id: string;
  /** Short display name, e.g. `claude-opus-5`. */
  displayName: string;
  /** Publisher, e.g. `anthropic`, `@cf/meta`. */
  author: string;
  description: string;
  /** Task type, e.g. `Text Generation`, `Text-to-Image`. */
  task: string;
  /** Capability chips: `Function calling`, `Vision`, `Batch`, `Third-party`, ... */
  tags: string[];
  contextWindow?: number;
  /** True for partner/third-party models billed through Unified Billing. */
  thirdParty: boolean;
  /** Cloudflare-hosted models are addressed as `@cf/...`. */
  cloudflareHosted: boolean;
  pricing: PriceInfo;
  /** Untouched API object, surfaced in the UI's "raw" view. */
  raw: unknown;
}

/** JSON Schema subset we care about when generating forms. */
export interface JsonSchema {
  type?: string | string[];
  description?: string;
  default?: unknown;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  format?: string;
  contentType?: string;
  title?: string;
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
}

export interface ModelSchema {
  input: JsonSchema;
  output: JsonSchema;
}

export interface CatalogPage {
  models: Model[];
  page: number;
  perPage: number;
  /** Total across all pages when the API reports it. */
  total?: number;
  /** True when another page is available. */
  hasMore: boolean;
}

/** Shape of an error surfaced to the UI, normalized from Cloudflare's error envelope. */
export interface ApiError {
  status: number;
  message: string;
  /** Cloudflare error codes, when present. */
  code?: number;
  hint?: string;
}
