import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { ApiError, Model } from "../../shared/types";
import { buildFacets, filterModels, type CatalogFilters, type SortOrder } from "../api/catalog";
import { FilterMenu } from "../components/FilterMenu";
import { ModelCard } from "../components/ModelCard";
import { describeAge } from "../state/catalogCache";
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

function SearchIcon() {
  return (
    <svg className="search-icon" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
      <line x1="13.5" y1="13.5" x2="18" y2="18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
