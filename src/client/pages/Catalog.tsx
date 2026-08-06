import { useMemo, useState } from "react";
import type { ApiError, Model } from "../../shared/types";
import { buildFacets, filterModels, type SortOrder } from "../api/catalog";
import { FilterMenu } from "../components/FilterMenu";
import { ModelCard } from "../components/ModelCard";

const SORT_LABELS: Record<SortOrder, string> = {
  name: "Name",
  "price-asc": "Price: low to high",
  "price-desc": "Price: high to low",
  task: "Task type",
};

export function Catalog({
  models,
  loading,
  error,
  onRetry,
}: {
  models: Model[];
  loading: boolean;
  error: ApiError | null;
  onRetry: () => void;
}) {
  const [search, setSearch] = useState("");
  const [tasks, setTasks] = useState<string[]>([]);
  const [authors, setAuthors] = useState<string[]>([]);
  const [hostingFilter, setHostingFilter] = useState<"all" | "cloudflare" | "third-party">("all");
  const [sort, setSort] = useState<SortOrder>("name");

  const facets = useMemo(() => buildFacets(models), [models]);
  const visible = useMemo(
    () => filterModels(models, { search, tasks, authors, hostingFilter, sort }),
    [models, search, tasks, authors, hostingFilter, sort],
  );

  const pricedCount = useMemo(
    () => models.filter((model) => model.pricing.entries.length > 0).length,
    [models],
  );

  const hasFilters = search !== "" || tasks.length > 0 || authors.length > 0 || hostingFilter !== "all";
  const clearAll = () => {
    setSearch("");
    setTasks([]);
    setAuthors([]);
    setHostingFilter("all");
  };

  if (error) {
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
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Search models"
          />
          {search && (
            <button type="button" className="search-clear" onClick={() => setSearch("")} aria-label="Clear search">
              ×
            </button>
          )}
        </div>

        <div className="filter-row">
          <FilterMenu label="Task types" options={facets.tasks} selected={tasks} onChange={setTasks} />
          <FilterMenu label="Authors" options={facets.authors} selected={authors} onChange={setAuthors} />

          <div className="segmented" role="group" aria-label="Hosting">
            {(["all", "cloudflare", "third-party"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={hostingFilter === value ? "is-selected" : ""}
                onClick={() => setHostingFilter(value)}
              >
                {value === "all" ? "All" : value === "cloudflare" ? "Cloudflare" : "Third-party"}
              </button>
            ))}
          </div>

          <label className="sort-wrap">
            <span className="sr-only">Sort by</span>
            <select
              className="field-input sort-select"
              value={sort}
              onChange={(event) => setSort(event.target.value as SortOrder)}
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

      <div className="result-line">
        {loading ? (
          <span className="loading-line">
            <span className="spinner small" aria-hidden="true" /> Loading catalog…
          </span>
        ) : (
          <>
            <span>
              <strong>{visible.length}</strong> of {models.length} models
              {pricedCount < models.length && models.length > 0 && (
                <span className="muted"> · {models.length - pricedCount} without published pricing</span>
              )}
            </span>
            {hasFilters && (
              <button type="button" className="link-button" onClick={clearAll}>
                Clear filters
              </button>
            )}
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
            <button type="button" className="secondary-button" onClick={clearAll}>
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
