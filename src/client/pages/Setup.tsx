import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ApiError, Credentials } from "../../shared/types";
import {
  beginOAuth,
  credentialsFromOAuth,
  exchangeOAuthCode,
  readOAuthCallback,
  type OAuthToken,
} from "../auth/oauth";
import { fetchCloudflareAccounts, RequestFailed, verifyCredentials } from "../api/client";
import { clearCredentials, loadCredentials, saveCredentials } from "../state/creds";

const TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens";

interface PendingOAuth {
  token: OAuthToken;
  accounts: { id: string; name: string }[];
}

function errorFromUnknown(err: unknown): ApiError {
  return err instanceof RequestFailed
    ? err.error
    : { status: 500, message: err instanceof Error ? err.message : "Could not connect." };
}

/** OAuth-first setup, with the manual token path kept intentionally compact. */
export function Setup({
  onConnected,
  hasExisting,
}: {
  onConnected: (creds: Credentials) => void;
  hasExisting: boolean;
}) {
  const existing = loadCredentials();
  const [accountId, setAccountId] = useState(existing?.accountId ?? "");
  const [apiToken, setApiToken] = useState(existing?.authMethod === "token" ? existing.apiToken : "");
  const [gatewayId, setGatewayId] = useState(existing?.gatewayId ?? "");
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [pendingOAuth, setPendingOAuth] = useState<PendingOAuth | null>(null);
  const [oauthAccountId, setOAuthAccountId] = useState("");
  const callbackStarted = useRef(false);

  useEffect(() => {
    if (callbackStarted.current) return;
    const callback = readOAuthCallback();
    if (!callback) return;
    callbackStarted.current = true;

    if ("error" in callback) {
      setError({ status: 400, message: callback.error });
      return;
    }

    setBusy(true);
    setError(null);
    exchangeOAuthCode(callback.code, callback.verifier)
      .then(async (token) => {
        const accounts = await fetchCloudflareAccounts(token.accessToken);
        if (accounts.length === 0) {
          throw new Error("No Cloudflare account is available for this sign-in.");
        }
        if (accounts.length === 1) {
          const creds = credentialsFromOAuth(accounts[0].id, token);
          saveCredentials(creds);
          window.history.replaceState({}, "", "/");
          onConnected(creds);
          return;
        }
        setPendingOAuth({ token, accounts });
        setOAuthAccountId(accounts[0].id);
      })
      .catch((err: unknown) => setError(errorFromUnknown(err)))
      .finally(() => setBusy(false));
  }, [onConnected]);

  const connectOAuthAccount = () => {
    if (!pendingOAuth || !oauthAccountId) return;
    const creds = credentialsFromOAuth(oauthAccountId, pendingOAuth.token, gatewayId);
    saveCredentials(creds);
    window.history.replaceState({}, "", "/");
    onConnected(creds);
  };

  const submitToken = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const creds: Credentials = {
      accountId: accountId.trim(),
      apiToken: apiToken.trim(),
      gatewayId: gatewayId.trim() || undefined,
      authMethod: "token",
    };

    try {
      await verifyCredentials(creds);
      saveCredentials(creds);
      onConnected(creds);
    } catch (err) {
      setError(errorFromUnknown(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="setup-page">
      <div className="setup-card">
        <header className="setup-head">
          <h1>Connect your Cloudflare account</h1>
          <p className="muted">Sign in securely to browse and run Cloudflare AI models.</p>
        </header>

        <section className="oauth-connect">
          <button
            type="button"
            className="primary-button oauth-button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void beginOAuth().catch((err: unknown) => {
                setBusy(false);
                setError(errorFromUnknown(err));
              });
            }}
          >
            {busy ? "Connecting…" : "Continue with Cloudflare"}
          </button>
          <p className="field-help oauth-help">No API token to copy or paste.</p>
        </section>

        {pendingOAuth && (
          <section className="account-picker" aria-label="Choose an account">
            <label className="field-label" htmlFor="oauth-account">
              Choose an account
            </label>
            <select
              id="oauth-account"
              className="field-input"
              value={oauthAccountId}
              onChange={(event) => setOAuthAccountId(event.target.value)}
            >
              {pendingOAuth.accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name} · {account.id}
                </option>
              ))}
            </select>
            <button type="button" className="primary-button" onClick={connectOAuthAccount}>
              Connect account
            </button>
          </section>
        )}

        {error && (
          <div className="output-error" role="alert">
            <h3>Could not connect · {error.status}</h3>
            <p>{error.message}</p>
            {error.hint && <p className="muted">{error.hint}</p>}
          </div>
        )}

        <details className="token-details">
          <summary>Use an API token instead</summary>
          <form onSubmit={submitToken} className="setup-form">
            <div className="field">
              <label className="field-label" htmlFor="account-id">
                Account ID
              </label>
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
                API token
              </label>
              <p className="field-help">
                Needs <strong>Workers AI → Edit</strong>. Add <strong>AI Gateway → Read</strong> for balance.
                {" "}
                <a href={TOKEN_URL} target="_blank" rel="noreferrer">
                  Create token ↗
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
                  onClick={() => setShowToken((value) => !value)}
                >
                  {showToken ? "Hide" : "Show"}
                </button>
              </div>
            </div>

            <div className="field">
              <label className="field-label" htmlFor="gateway-id">
                AI Gateway ID <span className="optional-tag">optional</span>
              </label>
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

            <div className="setup-actions">
              <button className="primary-button" type="submit" disabled={busy}>
                {busy ? "Verifying…" : "Connect with token"}
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
        </details>

        <footer className="setup-note">
          OAuth access is limited to the permissions you approve and can be revoked from Cloudflare.
          The app stores only the resulting session in this browser.
        </footer>
      </div>
    </div>
  );
}
