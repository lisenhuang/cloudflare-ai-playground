import type { Credentials } from "../../shared/types";

const STORAGE_KEY = "cf-models.creds";

/**
 * Credentials live in localStorage and nowhere else.
 *
 * This app is bring-your-own-key: the token is sent only to our own `/api/*`
 * proxy, which forwards it to api.cloudflare.com without storing it. Because a
 * Cloudflare API token is a powerful credential, the setup screen steers users
 * toward a token scoped to Workers AI alone.
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
