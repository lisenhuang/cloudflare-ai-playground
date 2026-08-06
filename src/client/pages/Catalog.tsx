import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ApiError, Model } from "../../shared/types";
import {
  buildFacets,
  filterModels,
  type CatalogFilters,
  type LoadPass,
  type SortOrder,
} from "../api/catalog";
import { FilterMenu } from "../components/FilterMenu";
import { ModelCard } from "../components/ModelCard";
import { describeAge } from "../state/catalogCache";
import { navigate } from "../state/useCatalog";
import { saveCatalogScroll, takeCatalogScroll } from "../state/useFilters";

const SORT_LABELS: Record<SortOrder, string> = {
  name: "Name",
  "price-asc": "Price: low to high",
  "price-desc": "Price: high to low",
  task: "Task type",
};

export function Catalog({
  models,
  loading,
  revalidating,
  error,
  fetchedAt,
  passes,
  filters,
  onFiltersChange,
  onClearFilters,
  onRetry,
}: {
  models: Model[];
  loading: boolean;
  revalidating: boolean;
  error: ApiError | null;
  fetchedAt: number | null;
  passes: LoadPass[];
  filters: CatalogFilters;
  onFiltersChange: (patch: Partial<CatalogFilters>) => void;
  onClearFilters: () => void;
  onRetry: () => void;
}) {
  const facets = useMemo(() => buildFacets(models), [models]);
  const visible = useMemo(() => filterModels(models, filters), [models, filters]);

  const pricedCount = useMemo(
    () => models.filter((model) => model.pricing.entries.length > 0).length,
    [models],
  );

  const cloudflareCount = useMemo(() => models.filter((m) => m.cloudflareHosted).length, [models]);
  const thirdPartyCount = models.length - cloudflareCount;
  const failedPasses = passes.filter((p) => p.error).length;

  const hasFilters =
    filters.search !== "" ||
    filters.tasks.length > 0 ||
    filters.authors.length > 0 ||
    filters.hostingFilter !== "all";

  // Remember where the user was, so returning from a model lands in place.
  const restored = useRef(false);
  useLayoutEffect(() => {
    if (restored.current || visible.length === 0) return;
    restored.current = true;
    const offset = takeCatalogScroll();
    if (offset > 0) window.scrollTo(0, offset);
  }, [visible.length]);

  useEffect(() => {
    const remember = () => saveCatalogScroll(window.scrollY);
    window.addEventListener("scroll", remember, { passive: true });
    return () => {
      remember();
      window.removeEventListener("scroll", remember);
    };
  }, []);

  // Only take over the page when there is nothing cached to fall back on.
  if (error && models.length === 0) {
    return (
      <div className="page">
        <div className="output-error" role="alert">
          <h3>Could not load the catalog · {error.status}</h3>
          <p>{error.message}</p>
          {error.hint && <p className="muted">{error.hint}</p>}
          <button type="button" className="primary-button" onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>Models</h1>
        <p className="muted">
          Every model in your Cloudflare catalog — Workers AI and third-party alike — with live
          pricing and a form generated from each model's own schema.
        </p>
      </header>

      <div className="toolbar">
        <div className="search-wrap">
          <SearchIcon />
          <input
            className="search-input"
            placeholder="Search models…"
            value={filters.search}
            onChange={(event) => onFiltersChange({ search: event.target.value })}
            aria-label="Search models"
          />
          {filters.search && (
            <button
              type="button"
              className="search-clear"
              onClick={() => onFiltersChange({ search: "" })}
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>

        <div className="filter-row">
          <FilterMenu
            label="Task types"
            options={facets.tasks}
            selected={filters.tasks}
            onChange={(tasks) => onFiltersChange({ tasks })}
          />
          <FilterMenu
            label="Authors"
            options={facets.authors}
            selected={filters.authors}
            onChange={(authors) => onFiltersChange({ authors })}
          />

          <div className="segmented" role="group" aria-label="Hosting">
            {(["all", "cloudflare", "third-party"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={filters.hostingFilter === value ? "is-selected" : ""}
                onClick={() => onFiltersChange({ hostingFilter: value })}
              >
                {value === "all" ? "All" : value === "cloudflare" ? "Cloudflare" : "Third-party"}
              </button>
            ))}
          </div>

          <label className="sort-wrap">
            <span className="sr-only">Sort by</span>
            <select
              className="field-input sort-select"
              value={filters.sort}
              onChange={(event) => onFiltersChange({ sort: event.target.value as SortOrder })}
            >
              {(Object.keys(SORT_LABELS) as SortOrder[]).map((value) => (
                <option key={value} value={value}>
                  {SORT_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/*
        Which query returned what, including failures. Without this a pass that
        errors looks identical to a provider that genuinely has no models —
        which is exactly how the missing third-party models stayed invisible.
      */}
      {/*
        Surfaced prominently rather than buried: an empty third-party list looks
        like a broken app, when it is actually an account billing state.
      */}
      {/*
        Only shown when the published-catalog fetch failed. Normally third-party
        models are listed and this stays hidden.
      */}
      {!loading && models.length > 0 && thirdPartyCount === 0 && (
        <div className="billing-notice" role="status">
          <strong>Third-party models could not be listed.</strong>
          <p>
            Cloudflare's catalog API only ever returns Workers AI models, so this app reads the
            published catalog for the rest — and that lookup came back empty (see Catalog coverage
            below). They still run through the same endpoint, so you can open one by ID. Running one
            needs credits in your AI Gateway, or a provider key via BYOK; without them it returns{" "}
            <code>402 Insufficient balance</code>.
          </p>
          <ModelIdEntry />
          <details className="billing-steps">
            <summary>How to add credits</summary>
            <ol>
              <li>
                Open{" "}
                <a
                  href="https://dash.cloudflare.com/?to=/:account/ai/ai-gateway"
                  target="_blank"
                  rel="noreferrer"
                >
                  AI Gateway ↗
                </a>{" "}
                in the Cloudflare dashboard.
              </li>
              <li>
                In the <strong>Credits Available</strong> card at the top right, select{" "}
                <strong>Manage</strong>.
              </li>
              <li>Add a payment method if you have not already.</li>
              <li>
                Choose <strong>Top-up credits</strong>, enter an amount, and confirm.
              </li>
              <li>
                Come back and hit <strong>Refresh</strong> — third-party models should appear.
              </li>
            </ol>
            <p className="muted">
              Cloudflare adds a <strong>5% fee</strong> on credits bought this way ($100 of credit
              costs $105), and passes provider inference rates through without markup. Optional:{" "}
              <strong>Manage → Setup auto top-up</strong> refills automatically below a threshold.
            </p>
            <p className="muted">
              <strong>Or skip credits entirely with BYOK.</strong> Store your own Anthropic / OpenAI
              / Google key on the gateway under the <code>default</code> alias, and it is used ahead
              of Unified Billing — you pay that provider directly instead of Cloudflare.
            </p>
          </details>

          <p className="billing-actions">
            <a
              className="secondary-button small"
              href="https://dash.cloudflare.com/?to=/:account/ai/ai-gateway"
              target="_blank"
              rel="noreferrer"
            >
              Open AI Gateway ↗
            </a>
            <a
              className="link-button"
              href="https://developers.cloudflare.com/ai-gateway/features/unified-billing/"
              target="_blank"
              rel="noreferrer"
            >
              Unified Billing docs ↗
            </a>
          </p>
        </div>
      )}

      {passes.length > 0 && (
        <details className="coverage" open={thirdPartyCount === 0}>
          <summary>
            Catalog coverage: <strong>{cloudflareCount}</strong> Cloudflare-hosted ·{" "}
            <strong>{thirdPartyCount}</strong> third-party
            {failedPasses > 0 && <span className="coverage-warn"> · {failedPasses} query failed</span>}
          </summary>
          <table className="coverage-table">
            <thead>
              <tr>
                <th>Query</th>
                <th>Models</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {passes.map((pass) => (
                <tr key={pass.label} className={pass.error ? "is-error" : ""}>
                  <td className="mono">{pass.label}</td>
                  <td className="mono">{pass.items}</td>
                  <td>{pass.error ?? "ok"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {thirdPartyCount === 0 && (
            <p className="muted small">
              Cloudflare's catalog API is returning only Workers AI models for this account.
              Third-party models (Anthropic, Google, OpenAI, ElevenLabs and the rest) are gated
              behind <strong>Unified Billing</strong>: until the AI Gateway has credits — or a
              provider key via BYOK — they are not listed, and running one returns{" "}
              <code>402 Insufficient balance</code>. This is an account state, not a token
              permission. Add credits under{" "}
              <a
                href="https://dash.cloudflare.com/?to=/:account/ai/ai-gateway"
                target="_blank"
                rel="noreferrer"
              >
                AI Gateway ↗
              </a>
              , then hit Refresh. Full list:{" "}
              <a
                href="https://developers.cloudflare.com/ai/models/?providers=third-party"
                target="_blank"
                rel="noreferrer"
              >
                third-party models ↗
              </a>
              .
            </p>
          )}
        </details>
      )}

      {/* Always available: any valid model id works, listed or not. */}
      <details className="id-entry-panel">
        <summary>Open a model by ID</summary>
        <p className="muted small">
          Any identifier Cloudflare will run works here, whether or not it appears in the grid — for
          example <code>anthropic/claude-opus-5</code> or <code>@cf/meta/llama-3.1-8b-instruct</code>.
        </p>
        <ModelIdEntry />
      </details>

      {error && models.length > 0 && (
        <div className="notice" role="status">
          <strong>Could not refresh from Cloudflare.</strong> {error.message}{" "}
          {error.hint && <span className="muted">{error.hint}</span>}
        </div>
      )}

      <div className="result-line">
        {loading ? (
          <span className="loading-line">
            <span className="spinner small" aria-hidden="true" /> Loading catalog from Cloudflare…
          </span>
        ) : (
          <>
            <span>
              <strong>{visible.length}</strong> of {models.length} models
              {pricedCount < models.length && models.length > 0 && (
                <span className="muted"> · {models.length - pricedCount} without published pricing</span>
              )}
            </span>
            <span className="result-actions">
              {hasFilters && (
                <button type="button" className="link-button" onClick={onClearFilters}>
                  Clear filters
                </button>
              )}
              <span className="freshness muted">
                {revalidating ? (
                  <>
                    <span className="spinner small" aria-hidden="true" /> refreshing…
                  </>
                ) : (
                  fetchedAt !== null && `updated ${describeAge(fetchedAt)}`
                )}
              </span>
              <button
                type="button"
                className="ghost-button small"
                onClick={onRetry}
                disabled={revalidating}
                title="Re-fetch the model list from Cloudflare"
              >
                Refresh
              </button>
            </span>
          </>
        )}
      </div>

      {loading && models.length === 0 ? (
        <div className="model-grid">
          {Array.from({ length: 6 }, (_, index) => (
            <div className="model-card skeleton" key={index} aria-hidden="true" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="output-empty">
          <p>No models match those filters.</p>
          {hasFilters && (
            <button type="button" className="secondary-button" onClick={onClearFilters}>
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="model-grid">
          {visible.map((model) => (
            <ModelCard key={model.id} model={model} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Escape hatch for models Cloudflare will run but will not list.
 *
 * The runner only needs an id, so any valid model identifier works here —
 * including every third-party model, none of which appear in the catalog API.
 */
function ModelIdEntry() {
  const [value, setValue] = useState("");
  const trimmed = value.trim();

  return (
    <form
      className="model-id-entry"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed) navigate(`/m/${encodeURIComponent(trimmed)}`);
      }}
    >
      <input
        className="field-input mono"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="anthropic/claude-opus-5"
        aria-label="Model ID"
        spellCheck={false}
        autoComplete="off"
      />
      <button type="submit" className="primary-button small" disabled={!trimmed}>
        Open model
      </button>
    </form>
  );
}

function SearchIcon() {
  return (
    <svg className="search-icon" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
      <line x1="13.5" y1="13.5" x2="18" y2="18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
