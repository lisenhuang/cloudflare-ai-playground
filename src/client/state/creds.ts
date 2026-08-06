import type { Credentials } from "../../shared/types";

const STORAGE_KEY = "cf-models.creds";

/**
 * Credentials live in localStorage and nowhere else. OAuth access tokens are
 * short-lived; manual API tokens are supported only as the explicit fallback.
 *
 * This app is bring-your-own-key: the token is sent only to our own `/api/*`
 * proxy, which forwards it to api.cloudflare.com without storing it. The setup
 * screen steers new users toward scoped Cloudflare OAuth.
 */
export function loadCredentials(): Credentials | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Credentials>;
    if (!parsed.accountId || !parsed.apiToken) return null;
    return {
      accountId: parsed.accountId,
      apiToken: parsed.apiToken,
      gatewayId: parsed.gatewayId || undefined,
      authMethod: parsed.authMethod === "oauth" ? "oauth" : "token",
      refreshToken: parsed.refreshToken || undefined,
      expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : undefined,
    };
  } catch {
    return null;
  }
}

export function saveCredentials(creds: Credentials): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(creds));
}

export function clearCredentials(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** Masks a token for display: keeps just enough to recognize which one it is. */
export function maskToken(token: string): string {
  if (token.length <= 8) return "•".repeat(token.length);
  return `${token.slice(0, 4)}${"•".repeat(Math.min(16, token.length - 8))}${token.slice(-4)}`;
}
