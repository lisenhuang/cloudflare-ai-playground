import { useEffect, useMemo, useRef, useState } from "react";
import { CF_MODEL_CATALOG_URL, type Credentials, type Model } from "../shared/types";
import { fetchCreditBalance, RequestFailed } from "./api/client";
import { Catalog } from "./pages/Catalog";
import { ModelRunner } from "./pages/ModelRunner";
import { Setup } from "./pages/Setup";
import { clearCatalogCache } from "./state/catalogCache";
import { clearCredentials, loadCredentials, maskToken } from "./state/creds";
import { useTheme } from "./state/theme";
import { navigate, useCatalog, useHashRoute } from "./state/useCatalog";
import { useFilters } from "./state/useFilters";

/**
 * A model deep-linked by id that is not (yet) in the loaded catalog still
 * deserves to run — the runner only really needs an id.
 */
function placeholderModel(id: string): Model {
  const cloudflareHosted = id.startsWith("@cf/");
  const segments = (cloudflareHosted ? id.slice(4) : id).split("/").filter(Boolean);
  return {
    id,
    displayName: segments[segments.length - 1] ?? id,
    author: segments.length > 1 ? segments[0] : "unknown",
    description: "",
    task: "Unknown",
    tags: [],
    thirdParty: !cloudflareHosted,
    cloudflareHosted,
    pricing: { entries: [], source: "none" },
    raw: null,
  };
}

function ThemeToggle() {
  const { choice, resolved, cycle } = useTheme();
  const label = choice === "system" ? `System (${resolved})` : choice === "light" ? "Light" : "Dark";

  return (
    <button type="button" className="icon-button" onClick={cycle} title={`Theme: ${label}`} aria-label={`Theme: ${label}. Click to change.`}>
      {choice === "system" ? <SystemIcon /> : resolved === "dark" ? <MoonIcon /> : <SunIcon />}
    </button>
  );
}

function AccountMenu({ creds, onDisconnect }: { creds: Credentials; onDisconnect: () => void }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  return (
    <div className="account-menu" ref={container}>
      <button type="button" className="icon-button" onClick={() => setOpen((v) => !v)} aria-label="Account">
        <KeyIcon />
      </button>
      {open && (
        <div className="account-popover">
          <p className="account-label">Account</p>
          <code className="mono account-value">{creds.accountId}</code>
          <p className="account-label">Token</p>
          <code className="mono account-value">
            {creds.authMethod === "oauth" ? "Cloudflare OAuth" : maskToken(creds.apiToken)}
          </code>
          {creds.gatewayId && (
            <>
              <p className="account-label">Gateway</p>
              <code className="mono account-value">{creds.gatewayId}</code>
            </>
          )}
          <div className="account-actions">
            <button type="button" className="secondary-button small" onClick={() => navigate("/setup")}>
              Change
            </button>
            <button type="button" className="ghost-button danger" onClick={onDisconnect}>
              Disconnect
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatCreditBalance(balance: number): string {
  const fractionDigits = Math.abs(balance) < 1 ? 4 : 2;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(balance);
}

function CreditBalance({ creds }: { creds: Credentials }) {
  const [balance, setBalance] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    fetchCreditBalance(creds)
      .then(({ balance: nextBalance }) => {
        if (cancelled) return;
        setBalance(nextBalance);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof RequestFailed) {
          setError(err.error.message + (err.error.hint ? " " + err.error.hint : ""));
        } else {
          setError(err instanceof Error ? err.message : "Could not read the AI Gateway balance.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    const interval = window.setInterval(() => setRefreshNonce((current) => current + 1), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [creds, refreshNonce]);

  const label =
    balance === null
      ? loading
        ? "Credits …"
        : "Credits unavailable"
      : "Credits " + formatCreditBalance(balance);

  return (
    <button
      type="button"
      className={"credit-balance" + (error ? " is-error" : "")}
      onClick={() => setRefreshNonce((current) => current + 1)}
      title={error ?? "Refresh AI Gateway credit balance"}
      aria-label={error ? "AI Gateway credit balance unavailable: " + error : label}
    >
      {label}
      {balance !== null && loading && <span aria-hidden="true"> ·</span>}
      {balance !== null && loading && <span className="credit-refresh-dot" aria-hidden="true">…</span>}
    </button>
  );
}

export default function App() {
  const [creds, setCreds] = useState<Credentials | null>(loadCredentials);
  const route = useHashRoute();
  const { models, loading, revalidating, error, fetchedAt, passes, reload } = useCatalog(creds);
  // Held here rather than inside Catalog, so opening a model and coming back
  // does not throw away the filters the user set.
  const { filters, update: updateFilters, reset: resetFilters } = useFilters();

  const activeModel = useMemo(() => {
    if (route.name !== "model" || !route.modelId) return null;
    return models.find((model) => model.id === route.modelId) ?? placeholderModel(route.modelId);
  }, [route, models]);

  const disconnect = () => {
    // The cached catalog belongs to that account — clear it out with the token.
    if (creds) clearCatalogCache(creds.accountId);
    clearCredentials();
    setCreds(null);
    navigate("/setup");
  };

  const needsSetup = !creds || route.name === "setup" || window.location.pathname === "/oauth/callback";

  return (
    <div className="app">
      <header className="app-header">
        <button type="button" className="brand" onClick={() => navigate("/")}>
          <CloudIcon />
          <span className="brand-text">
            CF Models
            <span className="brand-sub">Cloudflare AI playground</span>
          </span>
        </button>

        <div className="header-actions">
          <a
            className="doc-link"
            href={CF_MODEL_CATALOG_URL}
            target="_blank"
            rel="noreferrer"
            title="Cloudflare's model catalog documentation"
          >
            <span className="doc-link-full">Model catalog</span>
            <span className="doc-link-short">Docs</span> <span aria-hidden="true">↗</span>
          </a>
          {creds && !needsSetup && <CreditBalance creds={creds} />}
          <span className="app-version mono" title={`CF Models version ${__APP_VERSION__}`}>
            v{__APP_VERSION__}
          </span>
          <ThemeToggle />
          {creds && <AccountMenu creds={creds} onDisconnect={disconnect} />}
        </div>
      </header>

      <main className="app-main">
        {needsSetup ? (
          <Setup
            hasExisting={Boolean(creds)}
            onConnected={(next) => {
              setCreds(next);
              navigate("/");
            }}
          />
        ) : route.name === "model" && activeModel && creds ? (
          <ModelRunner creds={creds} model={activeModel} />
        ) : (
          <Catalog
            models={models}
            loading={loading}
            revalidating={revalidating}
            error={error}
            fetchedAt={fetchedAt}
            passes={passes}
            filters={filters}
            onFiltersChange={updateFilters}
            onClearFilters={resetFilters}
            onRetry={reload}
          />
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function CloudIcon() {
  return (
    <svg viewBox="0 0 24 24" className="brand-icon" aria-hidden="true">
      <path
        d="M6.5 18a4 4 0 0 1-.4-7.98A5.5 5.5 0 0 1 17 9.2 3.9 3.9 0 0 1 18.5 18Z"
        fill="currentColor"
      />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" fill="currentColor" />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => (
        <line
          key={angle}
          x1="12"
          y1="2.6"
          x2="12"
          y2="5.2"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          transform={`rotate(${angle} 12 12)`}
        />
      ))}
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2Z"
        fill="currentColor"
      />
    </svg>
  );
}

function SystemIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4.5" width="18" height="12.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 4.5v12.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 4.6a6.2 6.2 0 0 1 0 12.4Z" fill="currentColor" />
      <line x1="8" y1="20" x2="16" y2="20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="8.5" cy="8.5" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.9" />
      <path d="m11.8 11.8 8 8M17 17l2.2-2.2M14.4 14.4l2.2-2.2" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" fill="none" />
    </svg>
  );
}
