import { useState } from "react";
import type { ApiError, Credentials } from "../../shared/types";
import { RequestFailed, verifyCredentials } from "../api/client";
import { clearCredentials, loadCredentials, saveCredentials } from "../state/creds";

const TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens";

/**
 * Bring-your-own-key entry point.
 *
 * The token never leaves the browser except to reach this app's own proxy on
 * its way to api.cloudflare.com. Because a Cloudflare token can be powerful,
 * this screen is explicit about scoping it down to Workers AI alone.
 */
export function Setup({
  onConnected,
  hasExisting,
}: {
  onConnected: (creds: Credentials) => void;
  hasExisting: boolean;
}) {
  const existing = loadCredentials();
  const [accountId, setAccountId] = useState(existing?.accountId ?? "");
  const [apiToken, setApiToken] = useState(existing?.apiToken ?? "");
  const [gatewayId, setGatewayId] = useState(existing?.gatewayId ?? "");
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const creds: Credentials = {
      accountId: accountId.trim(),
      apiToken: apiToken.trim(),
      gatewayId: gatewayId.trim() || undefined,
    };

    try {
      await verifyCredentials(creds);
      saveCredentials(creds);
      onConnected(creds);
    } catch (err) {
      setError(
        err instanceof RequestFailed
          ? err.error
          : { status: 500, message: (err as Error).message ?? "Could not verify credentials." },
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="setup-page">
      <div className="setup-card">
        <header className="setup-head">
          <h1>Connect your Cloudflare account</h1>
          <p className="muted">
            This playground runs on your own credentials. Everything you generate is billed to your
            account, and your token stays in this browser.
          </p>
        </header>

        <form onSubmit={submit} className="setup-form">
          <div className="field">
            <label className="field-label" htmlFor="account-id">
              Account ID <span className="required-dot">*</span>
            </label>
            <p className="field-help">
              The 32-character hex string in your dashboard URL, right after <code>dash.cloudflare.com/</code>.
            </p>
            <input
              id="account-id"
              className="field-input mono"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              placeholder="5a2f48cb25e9919ef74db64f072e73ed"
              autoComplete="off"
              spellCheck={false}
              required
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="api-token">
              API token <span className="required-dot">*</span>
            </label>
            <p className="field-help">
              Create one with the <strong>Workers AI → Edit</strong> permission and nothing else. Add{" "}
              <strong>AI Gateway → Run</strong> only if you use a gateway.{" "}
              <a href={TOKEN_URL} target="_blank" rel="noreferrer">
                Create a token ↗
              </a>
            </p>
            <div className="token-row">
              <input
                id="api-token"
                className="field-input mono"
                type={showToken ? "text" : "password"}
                value={apiToken}
                onChange={(event) => setApiToken(event.target.value)}
                placeholder="••••••••••••••••••••••••••••••"
                autoComplete="off"
                spellCheck={false}
                required
              />
              <button
                type="button"
                className="secondary-button small"
                onClick={() => setShowToken((v) => !v)}
              >
                {showToken ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="gateway-id">
              AI Gateway ID <span className="optional-tag">optional</span>
            </label>
            <p className="field-help">
              Lets every model — including Cloudflare-hosted ones — go through the unified endpoint,
              and adds per-request cost reporting. Without it, Workers AI models use the direct route.
            </p>
            <input
              id="gateway-id"
              className="field-input mono"
              value={gatewayId}
              onChange={(event) => setGatewayId(event.target.value)}
              placeholder="my-gateway"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          {error && (
            <div className="output-error" role="alert">
              <h3>Could not connect · {error.status}</h3>
              <p>{error.message}</p>
              {error.hint && <p className="muted">{error.hint}</p>}
            </div>
          )}

          <div className="setup-actions">
            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? "Verifying…" : "Connect"}
            </button>
            {hasExisting && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  clearCredentials();
                  setAccountId("");
                  setApiToken("");
                  setGatewayId("");
                }}
              >
                Clear stored credentials
              </button>
            )}
          </div>
        </form>

        <footer className="setup-note">
          <strong>Where your token goes.</strong> It is kept in this browser's localStorage and sent
          only to this app's own <code>/api/*</code> proxy, which forwards it to api.cloudflare.com
          without storing or logging it. Anyone with access to this browser profile can read it, so
          scope the token narrowly and give it an expiry.
        </footer>
      </div>
    </div>
  );
}
