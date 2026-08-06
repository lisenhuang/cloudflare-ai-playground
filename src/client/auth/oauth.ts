import type { Credentials } from "../../shared/types";
import { saveCredentials } from "../state/creds";

/** Public PKCE client registered for the deployed application. */
export const CF_OAUTH_CLIENT_ID = "90fb03a1c8b6372a6478d599735719d6";
export const OAUTH_REDIRECT_URI = "https://cf-models.ase.workers.dev/oauth/callback";
export const OAUTH_AUTH_ENDPOINT = "https://dash.cloudflare.com/oauth2/auth";
export const OAUTH_TOKEN_ENDPOINT = "https://dash.cloudflare.com/oauth2/token";

/** Permission IDs selected on the Cloudflare OAuth client. */
export const OAUTH_SCOPES = [
  "account-settings.read",
  "aig.read",
  "aig.run",
  "ai.read",
  "ai.write",
] as const;

const STATE_KEY = "cf-models.oauth.state";
const VERIFIER_KEY = "cf-models.oauth.verifier";

export interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

function base64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomUrlPart(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes.buffer);
}

async function createChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(digest);
}

/** Starts the browser-based Authorization Code + PKCE flow. */
export async function beginOAuth(): Promise<void> {
  const state = `cfm_${randomUrlPart(24)}`;
  // Prefixing keeps the verifier/challenge comfortably inside OAuth's allowed
  // character set and avoids edge-case parsers rejecting a leading '-'/'_'.
  let verifier = "";
  let challenge = "";
  do {
    verifier = `cfm_${randomUrlPart(48)}`;
    challenge = await createChallenge(verifier);
  } while (!/^[A-Za-z0-9]/.test(challenge));

  sessionStorage.setItem(STATE_KEY, state);
  sessionStorage.setItem(VERIFIER_KEY, verifier);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CF_OAUTH_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: OAUTH_SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  window.location.assign(`${OAUTH_AUTH_ENDPOINT}?${params.toString()}`);
}

export function readOAuthCallback(): { code: string; verifier: string } | { error: string } | null {
  if (window.location.pathname !== "/oauth/callback") return null;

  const params = new URLSearchParams(window.location.search);
  const error = params.get("error");
  if (error) {
    const description = params.get("error_description");
    return { error: description ? `${error}: ${description}` : error };
  }

  const code = params.get("code");
  const state = params.get("state");
  const expectedState = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);

  if (!code || !state || !expectedState || state !== expectedState || !verifier) {
    return { error: "The Cloudflare sign-in session expired. Please try again." };
  }
  return { code, verifier };
}

function tokenFromResponse(body: unknown): OAuthToken {
  const value = body as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  if (typeof value.access_token !== "string" || value.access_token.length === 0) {
    throw new Error("Cloudflare returned no access token.");
  }
  const expiresIn = typeof value.expires_in === "number" ? value.expires_in : Number(value.expires_in);
  return {
    accessToken: value.access_token,
    refreshToken: typeof value.refresh_token === "string" ? value.refresh_token : undefined,
    expiresAt: Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : undefined,
  };
}

async function tokenRequest(body: URLSearchParams): Promise<OAuthToken> {
  const response = await fetch(OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = (await response.json().catch(() => null)) as
    | { error?: string; error_description?: string }
    | Record<string, unknown>
    | null;
  if (!response.ok) {
    const message = payload && "error_description" in payload && typeof payload.error_description === "string"
      ? payload.error_description
      : payload && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : `Cloudflare OAuth failed with status ${response.status}.`;
    throw new Error(message);
  }
  return tokenFromResponse(payload);
}

export function exchangeOAuthCode(code: string, verifier: string): Promise<OAuthToken> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: CF_OAUTH_CLIENT_ID,
      redirect_uri: OAUTH_REDIRECT_URI,
      code_verifier: verifier,
    }),
  );
}

export function refreshOAuthToken(refreshToken: string): Promise<OAuthToken> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CF_OAUTH_CLIENT_ID,
    }),
  );
}

export function credentialsFromOAuth(accountId: string, token: OAuthToken, gatewayId?: string): Credentials {
  return {
    accountId,
    apiToken: token.accessToken,
    gatewayId: gatewayId || undefined,
    authMethod: "oauth",
    refreshToken: token.refreshToken,
    expiresAt: token.expiresAt,
  };
}

/** Stores refreshed OAuth tokens without changing the selected account. */
export function updateOAuthCredentials(creds: Credentials, token: OAuthToken): Credentials {
  const next = { ...creds, apiToken: token.accessToken, refreshToken: token.refreshToken ?? creds.refreshToken, expiresAt: token.expiresAt };
  saveCredentials(next);
  return next;
}
