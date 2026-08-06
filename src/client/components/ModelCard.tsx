import { useState } from "react";
import type { Model } from "../../shared/types";
import { dashboardPricingUrl, summarizePrice } from "../pricing/resolve";
import { navigate } from "../state/useCatalog";

/** Deterministic accent per author so the grid reads as grouped at a glance. */
function authorHue(author: string): number {
  let hash = 0;
  for (let i = 0; i < author.length; i++) hash = (hash * 31 + author.charCodeAt(i)) % 360;
  return hash;
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M ctx`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K ctx`;
  return `${tokens} ctx`;
}

export function ModelCard({ model }: { model: Model }) {
  const [copied, setCopied] = useState(false);
  const price = summarizePrice(model.pricing);

  const copyId = async (event: React.MouseEvent) => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(model.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked — the id is visible on the card anyway */
    }
  };

  const open = () => navigate(`/m/${encodeURIComponent(model.id)}`);

  return (
    <article
      className="model-card"
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`Open ${model.displayName}`}
    >
      <div className="card-top">
        <span
          className="model-avatar"
          style={{ "--hue": authorHue(model.author) } as React.CSSProperties}
          aria-hidden="true"
        >
          {model.displayName.charAt(0).toUpperCase()}
        </span>
        <div className="card-heading">
          <h3 className="model-name" title={model.id}>
            {model.displayName}
          </h3>
          <p className="model-author">{model.author}</p>
        </div>
      </div>

      <div className="badge-row">
        <span className="badge badge-task">{model.task}</span>
        {model.contextWindow && <span className="badge">{formatContext(model.contextWindow)}</span>}
        {model.thirdParty && <span className="badge badge-muted">Third-party</span>}
      </div>

      {model.description && <p className="model-description">{model.description}</p>}

      <div className="card-footer">
        <div className="price-block">
          {price ? (
            <span className="price-value">{price}</span>
          ) : model.thirdParty ? (
            <a
              className="price-missing"
              href={dashboardPricingUrl(model.id)}
              target="_blank"
              rel="noreferrer"
              title="Open this model's pricing in the Cloudflare dashboard"
              onClick={(event) => event.stopPropagation()}
            >
              Price in dashboard ↗
            </a>
          ) : (
            <span className="price-missing" title="Cloudflare does not publish a price for this model via the API">
              Price not published
            </span>
          )}
        </div>
        <div className="card-actions">
          <button type="button" className="ghost-button" onClick={copyId}>
            {copied ? "Copied" : "Copy ID"}
          </button>
          <button
            type="button"
            className="secondary-button small"
            onClick={(event) => {
              event.stopPropagation();
              open();
            }}
          >
            Try it
          </button>
        </div>
      </div>
    </article>
  );
}
