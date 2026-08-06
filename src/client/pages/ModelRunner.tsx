import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CF_MODEL_CATALOG_URL,
  type ApiError,
  type Credentials,
  type JsonSchema,
  type Model,
  type ModelSchema,
} from "../../shared/types";
import { RequestFailed, fetchModelSchema, pollQueuedJob, runModel } from "../api/client";
import { SchemaForm } from "../form/SchemaForm";
import { getVariants, initialValues, missingRequired, pruneValues } from "../form/schema";
import { OutputView, type Outcome } from "../output/OutputView";
import { formatEntry } from "../pricing/resolve";
import { navigate } from "../state/useCatalog";

const SCHEMA_CACHE_PREFIX = "cf-models.schema.";
const PENDING_KEY = "cf-models.pending";
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

interface PendingJob {
  modelId: string;
  requestId: string;
  startedAt: number;
}

/** Schemas change rarely; caching makes switching models feel instant. */
async function loadSchema(creds: Credentials, modelId: string): Promise<ModelSchema> {
  const key = SCHEMA_CACHE_PREFIX + modelId;
  try {
    const cached = sessionStorage.getItem(key);
    if (cached) return JSON.parse(cached) as ModelSchema;
  } catch {
    /* cache miss is not an error */
  }
  const schema = await fetchModelSchema(creds, modelId);
  try {
    sessionStorage.setItem(key, JSON.stringify(schema));
  } catch {
    /* storage full — proceed uncached */
  }
  return schema;
}

const QUEUED_STATUSES = ["queued", "starting", "pending", "processing", "in_progress"];

/**
 * Detects a queued job.
 *
 * Deliberately strict: an `id` alone is not enough, because ordinary
 * OpenAI-compatible completions carry one too and would otherwise be mistaken
 * for a queued job and polled forever.
 */
function extractRequestId(payload: unknown): string | null {
  const body = (payload ?? {}) as Record<string, unknown>;
  const result = (body.result ?? body) as Record<string, unknown>;
  const status = String(result.status ?? "").toLowerCase();

  for (const key of ["request_id", "requestId"]) {
    const value = result[key];
    if (typeof value === "string" && value) return value;
  }
  // A bare `id` counts only when the payload explicitly says it is queued.
  if (QUEUED_STATUSES.includes(status) && typeof result.id === "string" && result.id) {
    return result.id;
  }
  return null;
}

function isTerminal(payload: unknown): boolean {
  const body = (payload ?? {}) as Record<string, unknown>;
  const result = (body.result ?? body) as Record<string, unknown>;
  const status = String(result.status ?? "").toLowerCase();
  if (["complete", "completed", "succeeded", "success", "failed", "error", "canceled"].includes(status)) {
    return true;
  }
  // No status field but real output present → done.
  return status === "" && Object.keys(result).some((key) => key !== "request_id" && key !== "id");
}

async function consumeStream(
  stream: ReadableStream<Uint8Array>,
  onDelta: (delta: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const json = JSON.parse(payload) as Record<string, any>;
        const delta =
          json.response ?? json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.text ?? "";
        if (typeof delta === "string" && delta) onDelta(delta);
      } catch {
        /* keep-alive or partial frame — ignore */
      }
    }
  }
}

export function ModelRunner({ creds, model }: { creds: Credentials; model: Model }) {
  const [schema, setSchema] = useState<ModelSchema | null>(null);
  const [schemaError, setSchemaError] = useState<ApiError | null>(null);
  const [variantIndex, setVariantIndex] = useState(0);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState("{}");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const [mobilePane, setMobilePane] = useState<"input" | "output">("input");
  const [sessionCost, setSessionCost] = useState(0);
  const [queueNote, setQueueNote] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const variants = useMemo(() => (schema ? getVariants(schema.input) : []), [schema]);
  const activeSchema: JsonSchema | null = variants[variantIndex]?.schema ?? null;

  // Load the schema for this model.
  useEffect(() => {
    let cancelled = false;
    setSchema(null);
    setSchemaError(null);
    setOutcome({ kind: "idle" });
    setVariantIndex(0);

    loadSchema(creds, model.id)
      .then((loaded) => {
        if (!cancelled) setSchema(loaded);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setSchemaError(
          err instanceof RequestFailed
            ? err.error
            : { status: 500, message: (err as Error).message ?? "Could not load the model schema." },
        );
        // Third-party models have no published schema, so the JSON editor is
        // the only way in. Seed it with a chat-shaped starting point rather
        // than an empty object — it is a template to edit, not a claim about
        // this model's parameters.
        setJsonMode(true);
        setJsonText(
          JSON.stringify(
            { messages: [{ role: "user", content: "" }], max_tokens: 1024 },
            null,
            2,
          ),
        );
        setValues({ messages: [{ role: "user", content: "" }], max_tokens: 1024 });
      });

    return () => {
      cancelled = true;
    };
  }, [creds, model.id]);

  // Seed values whenever the active variant changes.
  useEffect(() => {
    if (!activeSchema) return;
    const seeded = initialValues(activeSchema);
    setValues(seeded);
    setJsonText(JSON.stringify(seeded, null, 2));
  }, [activeSchema]);

  const applyValues = (next: Record<string, unknown>) => {
    setValues(next);
    setJsonText(JSON.stringify(next, null, 2));
  };

  const applyJsonText = (text: string) => {
    setJsonText(text);
    try {
      const parsed = JSON.parse(text || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        setValues(parsed as Record<string, unknown>);
        setJsonError(null);
      } else {
        setJsonError("Input must be a JSON object.");
      }
    } catch (err) {
      setJsonError((err as Error).message);
    }
  };

  const startPolling = useCallback(
    async (requestId: string) => {
      const job: PendingJob = { modelId: model.id, requestId, startedAt: Date.now() };
      try {
        localStorage.setItem(PENDING_KEY, JSON.stringify(job));
      } catch {
        /* ignore */
      }
      setQueueNote(`Queued as ${requestId}. This can take a few minutes.`);

      const startedAt = Date.now();
      while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        try {
          const payload = await pollQueuedJob(creds, model.id, requestId);
          if (isTerminal(payload)) {
            localStorage.removeItem(PENDING_KEY);
            setQueueNote(null);
            setOutcome({
              kind: "done",
              result: {
                kind: "json",
                contentType: "application/json",
                json: payload,
                telemetry: {},
                elapsedMs: Date.now() - startedAt,
              },
            });
            return;
          }
        } catch (err) {
          localStorage.removeItem(PENDING_KEY);
          setQueueNote(null);
          setOutcome({
            kind: "error",
            error:
              err instanceof RequestFailed
                ? err.error
                : { status: 500, message: (err as Error).message ?? "Polling failed." },
          });
          return;
        }
      }

      localStorage.removeItem(PENDING_KEY);
      setQueueNote(null);
      setOutcome({
        kind: "error",
        error: { status: 504, message: "Timed out waiting for the queued job.", hint: `Request id: ${requestId}` },
      });
    },
    [creds, model.id],
  );

  // Resume a job that was still running when the page was last closed.
  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(PENDING_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    try {
      const job = JSON.parse(raw) as PendingJob;
      if (job.modelId === model.id && Date.now() - job.startedAt < POLL_TIMEOUT_MS) {
        setOutcome({ kind: "running" });
        void startPolling(job.requestId);
      }
    } catch {
      /* corrupt entry — ignore */
    }
    // Intentionally runs once per model.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.id]);

  const run = async () => {
    if (jsonError) return;
    const schemaForValidation = activeSchema ?? { type: "object" };
    const missing = activeSchema ? missingRequired(values, activeSchema) : [];
    if (missing.length) {
      setOutcome({
        kind: "error",
        error: { status: 400, message: `Fill in the required field${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.` },
      });
      setMobilePane("output");
      return;
    }

    const payload = activeSchema ? pruneValues(values, schemaForValidation) : values;
    const controller = new AbortController();
    abortRef.current = controller;
    setOutcome({ kind: "running" });
    setQueueNote(null);
    setMobilePane("output");

    try {
      const result = await runModel(creds, model.id, payload, controller.signal);

      if (result.kind === "stream" && result.stream) {
        let text = "";
        setOutcome({ kind: "streaming", text });
        await consumeStream(result.stream, (delta) => {
          text += delta;
          setOutcome({ kind: "streaming", text });
        });
        setOutcome({ kind: "done", result, streamedText: text });
      } else {
        const requestId = result.kind === "json" ? extractRequestId(result.json) : null;
        if (requestId) {
          setOutcome({ kind: "running" });
          void startPolling(requestId);
        } else {
          setOutcome({ kind: "done", result });
        }
      }

      if (result.telemetry.costUsd) setSessionCost((total) => total + result.telemetry.costUsd!);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        setOutcome({ kind: "idle" });
        return;
      }
      setOutcome({
        kind: "error",
        error:
          err instanceof RequestFailed
            ? err.error
            : { status: 500, message: (err as Error).message ?? "The request failed." },
      });
    } finally {
      abortRef.current = null;
    }
  };

  const busy = outcome.kind === "running" || outcome.kind === "streaming";
  const billable = model.pricing.entries.filter((entry) => entry.currency.toLowerCase() !== "neurons");
  const neuronEntries = model.pricing.entries.filter((entry) => entry.currency.toLowerCase() === "neurons");

  return (
    <div className="runner-page">
      <header className="runner-head">
        <button type="button" className="back-button" onClick={() => navigate("/")}>
          ← All models
        </button>

        <div className="runner-title">
          <h1>{model.displayName}</h1>
          <code className="model-id mono">{model.id}</code>
        </div>

        <div className="badge-row">
          <span className="badge badge-task">{model.task}</span>
          <span className="badge">{model.author}</span>
          {model.thirdParty && <span className="badge badge-muted">Third-party</span>}
          {model.contextWindow && <span className="badge">{model.contextWindow.toLocaleString()} ctx</span>}
        </div>

        {model.description && <p className="runner-description">{model.description}</p>}

        {/*
          The exact fields Cloudflare returns per model are not documented, and
          guessing at them has already caused two wrong diagnoses. This shows
          the untouched catalog record so classification questions can be
          answered by looking rather than inferring.
        */}
        <details className="raw-record">
          <summary>Raw catalog record from Cloudflare</summary>
          {model.raw ? (
            <pre className="code-block json-block">
              <code>{JSON.stringify(model.raw, null, 2)}</code>
            </pre>
          ) : (
            <p className="muted small">
              This model came from the local cache, which does not keep the raw payload. Hit Refresh
              on the catalog to fetch it again.
            </p>
          )}
        </details>

        <div className="price-panel">
          <h2>Pricing</h2>
          {billable.length ? (
            <>
              <ul className="price-list">
                {billable.map((entry) => (
                  <li key={`${entry.unit}-${entry.price}`}>
                    <span className="price-amount">{formatEntry(entry)}</span>
                  </li>
                ))}
              </ul>
              {neuronEntries.length > 0 && (
                <p className="muted small">
                  {neuronEntries.map((entry) => formatEntry(entry)).join(" · ")}
                </p>
              )}
              <p className="price-source muted small">
                Source: {model.pricing.source === "openrouter" ? "catalog API (marketplace format)" : "catalog API"}
              </p>
            </>
          ) : (
            <p className="muted">
              Cloudflare does not publish a price for this model through the API. Nothing is estimated
              here — check{" "}
              <a href={CF_MODEL_CATALOG_URL} target="_blank" rel="noreferrer">
                Cloudflare's model catalog ↗
              </a>
              .
            </p>
          )}
        </div>
      </header>

      <div className="mobile-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mobilePane === "input"}
          className={mobilePane === "input" ? "is-selected" : ""}
          onClick={() => setMobilePane("input")}
        >
          Input
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mobilePane === "output"}
          className={mobilePane === "output" ? "is-selected" : ""}
          onClick={() => setMobilePane("output")}
        >
          Output
        </button>
      </div>

      <div className="runner-body">
        <section className={`panel input-panel ${mobilePane === "input" ? "" : "mobile-hidden"}`}>
          <div className="panel-head">
            <h2>Input</h2>
            <button type="button" className="link-button" onClick={() => setJsonMode((v) => !v)}>
              {jsonMode ? "Form" : "Edit as JSON"}
            </button>
          </div>

          {schemaError && (
            <div className="notice" role="status">
              <strong>Schema unavailable.</strong> {schemaError.message} You can still run this model
              with the JSON editor.
            </div>
          )}

          {!schema && !schemaError && (
            <div className="output-empty">
              <span className="spinner" aria-hidden="true" />
              <p>Loading schema…</p>
            </div>
          )}

          {variants.length > 1 && !jsonMode && (
            <div className="variant-tabs" role="tablist">
              {variants.map((variant, index) => (
                <button
                  key={variant.label}
                  type="button"
                  role="tab"
                  aria-selected={index === variantIndex}
                  className={index === variantIndex ? "is-selected" : ""}
                  onClick={() => setVariantIndex(index)}
                >
                  {variant.label}
                </button>
              ))}
            </div>
          )}

          {jsonMode ? (
            <div className="json-editor">
              <textarea
                className="field-input field-textarea json-textarea"
                value={jsonText}
                spellCheck={false}
                onChange={(event) => applyJsonText(event.target.value)}
              />
              {jsonError && <p className="field-error">{jsonError}</p>}
            </div>
          ) : (
            activeSchema && <SchemaForm schema={activeSchema} values={values} onChange={applyValues} />
          )}

          <div className="run-bar">
            <button type="button" className="primary-button" onClick={run} disabled={busy || Boolean(jsonError)}>
              {busy ? "Running…" : "Run model"}
            </button>
            {busy && abortRef.current && (
              <button type="button" className="secondary-button" onClick={() => abortRef.current?.abort()}>
                Cancel
              </button>
            )}
            {sessionCost > 0 && (
              <span className="session-cost mono" title="Total reported by Cloudflare this session">
                session ${sessionCost.toFixed(6)}
              </span>
            )}
          </div>
        </section>

        <section className={`panel output-panel ${mobilePane === "output" ? "" : "mobile-hidden"}`}>
          <div className="panel-head">
            <h2>Output</h2>
          </div>
          {queueNote && <div className="notice">{queueNote}</div>}
          <OutputView outcome={outcome} />
        </section>
      </div>
    </div>
  );
}
