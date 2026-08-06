import { useEffect, useRef, useState } from "react";
import type { Facet } from "../api/catalog";

/**
 * Multi-select facet dropdown with a search box and per-option counts —
 * the same shape as the Cloudflare dashboard's model filters.
 */
export function FilterMenu({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: Facet[];
  selected: string[];
  onChange: (selected: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? options.filter((option) => option.value.toLowerCase().includes(needle))
    : options;

  const toggle = (value: string) => {
    onChange(
      selected.includes(value) ? selected.filter((entry) => entry !== value) : [...selected, value],
    );
  };

  return (
    <div className="filter-menu" ref={container}>
      <button
        type="button"
        className={`filter-trigger ${selected.length ? "is-active" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
        {selected.length > 0 && <span className="count-pill">{selected.length}</span>}
        <span className={`chevron ${open ? "open" : ""}`} aria-hidden="true" />
      </button>

      {open && (
        <div className="filter-popover" role="dialog" aria-label={label}>
          <input
            className="field-input filter-search"
            placeholder="Search…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
          />
          <div className="filter-options">
            {visible.length === 0 && <p className="empty-note">No matches.</p>}
            {visible.map((option) => (
              <label className="filter-option" key={option.value}>
                <input
                  type="checkbox"
                  checked={selected.includes(option.value)}
                  onChange={() => toggle(option.value)}
                />
                <span className="filter-option-label">{option.value}</span>
                <span className="filter-count">{option.count}</span>
              </label>
            ))}
          </div>
          {selected.length > 0 && (
            <button type="button" className="link-button filter-clear" onClick={() => onChange([])}>
              Clear {label.toLowerCase()}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
