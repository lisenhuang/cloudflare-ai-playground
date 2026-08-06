import { useEffect, useMemo, useState } from "react";
import type { RunResult, RunTelemetry } from "../api/client";
import type { ApiError } from "../../shared/types";

/**
 * Output rendering, decided per task type.
 *
 * Response shapes across the catalog are genuinely inconsistent — base64 in
 * JSON, raw binary, a URL, an SSE stream — so this inspects the actual response
 * rather than trusting the task label, and always keeps a raw-JSON escape hatch.
 */

export type Outcome =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "streaming"; text: string }
  | { kind: "done"; result: RunResult; streamedText?: string }
  | { kind: "error"; error: ApiError };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function base64ToBlob(base64: string, type: string): Blob | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type });
  } catch {
    return null;
  }
}

const BASE64_RE = /^[A-Za-z0-9+/\r\n]+={0,2}$/;

function looksLikeBase64(value: unknown): value is string {
  return typeof value === "string" && value.length > 256 && BASE64_RE.test(value.slice(0, 512));
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//.test(value.trim());
}

function unwrap(payload: unknown): unknown {
  if (payload && typeof payload === "object" && "result" in (payload as Record<string, unknown>)) {
    return (payload as Record<string, unknown>).result;
  }
  return payload;
}

/** Uses an object URL for the lifetime of the component and revokes it after. */
function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

function DownloadButton({ blob, filename }: { blob: Blob; filename: string }) {
  const url = useObjectUrl(blob);
  if (!url) return null;
  return (
    <a className="secondary-button small" href={url} download={filename}>
      Download
    </a>
  );
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

/**
 * Lightweight text rendering: fenced code blocks get monospace treatment and
 * everything else keeps its line breaks. Not a full Markdown implementation —
 * deliberately, so nothing is silently swallowed.
 */
function TextOutput({ text, streaming }: { text: string; streaming?: boolean }) {
  const segments = useMemo(() => splitFences(text), [text]);
  return (
    <div className="text-output">
      {segments.map((segment, index) =>
        segment.type === "code" ? (
          <pre className="code-block" key={index}>
            {segment.language && <span className="code-lang">{segment.language}</span>}
            <code>{segment.content}</code>
          </pre>
        ) : (
          <p className="prose" key={index}>
            {segment.content}
          </p>
        ),
      )}
      {streaming && <span className="caret" aria-hidden="true" />}
    </div>
  );
}

function splitFences(text: string): Array<{ type: "text" | "code"; content: string; language?: string }> {
  const parts: Array<{ type: "text" | "code"; content: string; language?: string }> = [];
  const pattern = /```(\w*)\n?([\s\S]*?)(?:```|$)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: "text", content: text.slice(lastIndex, match.index) });
    }
    parts.push({ type: "code", content: match[2], language: match[1] || undefined });
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) parts.push({ type: "text", content: text.slice(lastIndex) });
  return parts.filter((part) => part.content.trim() !== "");
}

function ImageOutput({ blob }: { blob: Blob }) {
  const url = useObjectUrl(blob);
  if (!url) return null;
  return (
    <div className="media-output">
      <img src={url} alt="Model output" />
      <DownloadButton blob={blob} filename={`output.${blob.type.split("/")[1] || "png"}`} />
    </div>
  );
}

function AudioOutput({ blob }: { blob: Blob }) {
  const url = useObjectUrl(blob);
  if (!url) return null;
  return (
    <div className="media-output">
      <audio controls src={url} />
      <DownloadButton blob={blob} filename={`output.${blob.type.split("/")[1] || "mp3"}`} />
    </div>
  );
}

function VideoOutput({ src, blob }: { src: string; blob?: Blob }) {
  return (
    <div className="media-output">
      <video controls src={src} />
      {blob ? (
        <DownloadButton blob={blob} filename="output.mp4" />
      ) : (
        <a className="secondary-button small" href={src} target="_blank" rel="noreferrer">
          Open original
        </a>
      )}
    </div>
  );
}

function BlobVideoOutput({ blob }: { blob: Blob }) {
  const url = useObjectUrl(blob);
  if (!url) return null;
  return <VideoOutput src={url} blob={blob} />;
}

function EmbeddingOutput({ vectors }: { vectors: number[][] }) {
  const [expanded, setExpanded] = useState(false);
  const dimensions = vectors[0]?.length ?? 0;
  return (
    <div className="embedding-output">
      <p className="stat-line">
        <strong>{vectors.length}</strong> vector{vectors.length === 1 ? "" : "s"} ·{" "}
        <strong>{dimensions}</strong> dimensions
      </p>
      <pre className="code-block">
        <code>
          {vectors
            .slice(0, expanded ? vectors.length : 1)
            .map(
              (vector, index) =>
                `[${index}] ${vector
                  .slice(0, expanded ? vector.length : 12)
                  .map((n) => n.toFixed(4))
                  .join(", ")}${!expanded && vector.length > 12 ? ", …" : ""}`,
            )
            .join("\n")}
        </code>
      </pre>
      <button type="button" className="link-button" onClick={() => setExpanded((v) => !v)}>
        {expanded ? "Collapse" : "Show all values"}
      </button>
    </div>
  );
}

function ScoreOutput({ scores }: { scores: Array<{ label: string; score: number }> }) {
  const max = Math.max(...scores.map((s) => s.score), 1);
  return (
    <div className="score-output">
      {[...scores]
        .sort((a, b) => b.score - a.score)
        .map((entry) => (
          <div className="score-row" key={entry.label}>
            <span className="score-label">{entry.label}</span>
            <span className="score-bar">
              <span className="score-fill" style={{ width: `${(entry.score / max) * 100}%` }} />
            </span>
            <span className="score-value mono">{entry.score.toFixed(4)}</span>
          </div>
        ))}
    </div>
  );
}

function TranscriptOutput({ text, wordCount }: { text: string; wordCount?: number }) {
  return (
    <div className="transcript-output">
      {wordCount !== undefined && <p className="stat-line">{wordCount} words with timings</p>}
      <p className="prose">{text}</p>
    </div>
  );
}

function JsonOutput({ value }: { value: unknown }) {
  return (
    <pre className="code-block json-block">
      <code>{JSON.stringify(value, null, 2)}</code>
    </pre>
  );
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function renderJsonPayload(payload: unknown) {
  const result = unwrap(payload);

  if (typeof result === "string") return <TextOutput text={result} />;

  if (Array.isArray(result) && result.length && isScoreArray(result)) {
    return <ScoreOutput scores={result as Array<{ label: string; score: number }>} />;
  }

  const record = (result ?? {}) as Record<string, unknown>;

  // Text generation, both native and OpenAI-compatible shapes.
  const choices = record.choices;
  if (Array.isArray(choices) && choices.length) {
    const message = (choices[0] as Record<string, unknown>)?.message as Record<string, unknown> | undefined;
    const content = message?.content ?? (choices[0] as Record<string, unknown>)?.text;
    if (typeof content === "string") return <TextOutput text={content} />;
  }
  if (typeof record.response === "string") return <TextOutput text={record.response} />;

  // Image / audio delivered as base64 inside JSON.
  for (const [key, mime] of [
    ["image", "image/png"],
    ["audio", "audio/mpeg"],
  ] as const) {
    const value = record[key];
    if (looksLikeBase64(value)) {
      const blob = base64ToBlob(value, mime);
      if (blob) return key === "image" ? <ImageOutput blob={blob} /> : <AudioOutput blob={blob} />;
    }
  }

  // Video and other long-running jobs usually hand back a URL.
  for (const key of ["video", "url", "output", "video_url"]) {
    const value = record[key];
    if (isHttpUrl(value)) return <VideoOutput src={value} />;
    if (Array.isArray(value) && isHttpUrl(value[0])) return <VideoOutput src={value[0]} />;
  }

  // Speech recognition.
  if (typeof record.text === "string") {
    const words = Array.isArray(record.words) ? record.words.length : undefined;
    return <TranscriptOutput text={record.text} wordCount={words} />;
  }

  // Embeddings.
  const data = record.data;
  if (Array.isArray(data) && Array.isArray(data[0]) && typeof data[0][0] === "number") {
    return <EmbeddingOutput vectors={data as number[][]} />;
  }

  // Translation.
  if (typeof record.translated_text === "string") return <TextOutput text={record.translated_text} />;

  return <JsonOutput value={payload} />;
}

function isScoreArray(value: unknown[]): boolean {
  const first = value[0] as Record<string, unknown> | undefined;
  return Boolean(first && typeof first.label === "string" && typeof first.score === "number");
}

function renderResult(result: RunResult, streamedText?: string) {
  if (streamedText !== undefined) return <TextOutput text={streamedText} />;

  if (result.kind === "binary" && result.blob) {
    const type = result.blob.type || result.contentType;
    if (type.startsWith("image/")) return <ImageOutput blob={result.blob} />;
    if (type.startsWith("audio/")) return <AudioOutput blob={result.blob} />;
    if (type.startsWith("video/")) return <BlobVideoOutput blob={result.blob} />;
    return <p className="empty-note">Received {result.blob.size} bytes of {type || "unknown"} data.</p>;
  }

  if (result.kind === "json") return renderJsonPayload(result.json);
  return <p className="empty-note">No renderable output.</p>;
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function Telemetry({ telemetry, elapsedMs }: { telemetry: RunTelemetry; elapsedMs: number }) {
  const parts: string[] = [];
  // Cloudflare's reported cost is authoritative; the wall clock is ours.
  if (telemetry.costUsd !== undefined) parts.push(`$${telemetry.costUsd.toFixed(6)}`);
  parts.push(`${Math.round(telemetry.latencyMs ?? elapsedMs)} ms`);
  if (telemetry.cacheStatus) parts.push(telemetry.cacheStatus);

  return <span className="telemetry mono">{parts.join(" · ")}</span>;
}

export function OutputView({ outcome }: { outcome: Outcome }) {
  const [showRaw, setShowRaw] = useState(false);

  if (outcome.kind === "idle") {
    return (
      <div className="output-empty">
        <p>Fill in the inputs and run the model.</p>
        <p className="muted">Output renders according to the model's task type.</p>
      </div>
    );
  }

  if (outcome.kind === "running") {
    return (
      <div className="output-empty">
        <span className="spinner" aria-hidden="true" />
        <p>Running…</p>
      </div>
    );
  }

  if (outcome.kind === "error") {
    return (
      <div className="output-error" role="alert">
        <h3>Request failed · {outcome.error.status}</h3>
        <p>{outcome.error.message}</p>
        {outcome.error.hint && <p className="muted">{outcome.error.hint}</p>}
      </div>
    );
  }

  if (outcome.kind === "streaming") {
    return (
      <div className="output-body">
        <TextOutput text={outcome.text} streaming />
      </div>
    );
  }

  const { result, streamedText } = outcome;
  const canShowRaw = result.kind === "json";

  return (
    <div className="output-body">
      <div className="output-toolbar">
        <Telemetry telemetry={result.telemetry} elapsedMs={result.elapsedMs} />
        {canShowRaw && (
          <button type="button" className="link-button" onClick={() => setShowRaw((v) => !v)}>
            {showRaw ? "Rendered" : "Raw JSON"}
          </button>
        )}
      </div>
      {showRaw && canShowRaw ? <JsonOutput value={result.json} /> : renderResult(result, streamedText)}
    </div>
  );
}
