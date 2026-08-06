import { useEffect, useRef, useState } from "react";
import type { JsonSchema } from "../../shared/types";
import { getFields, humanize, pickWidget, type Field } from "./schema";

/**
 * Renders a form for any model from its input JSON Schema.
 *
 * There is deliberately no per-model code anywhere in here — a model Cloudflare
 * adds tomorrow gets a working form today. Where a field is too exotic to map,
 * it degrades to a JSON editor rather than becoming unusable.
 */

interface WidgetProps {
  field: Field;
  value: unknown;
  onChange: (value: unknown) => void;
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      // Strip the `data:*/*;base64,` prefix — the API wants the payload alone.
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function fileToBytes(file: File): Promise<number[]> {
  return Array.from(new Uint8Array(await file.arrayBuffer()));
}

function formatBytes(count: number): string {
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`;
  return `${(count / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

function AutoTextarea({
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 420)}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      className="field-input field-textarea"
      value={value}
      rows={rows}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function EnumWidget({ field, value, onChange }: WidgetProps) {
  const options = (field.schema.enum ?? []).map((option) => String(option));
  return (
    <select
      className="field-input"
      value={value === undefined ? "" : String(value)}
      onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value)}
    >
      {!field.required && <option value="">— not set —</option>}
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

function NumberWidget({ field, value, onChange }: WidgetProps) {
  const isInteger = field.schema.type === "integer";
  return (
    <input
      className="field-input"
      type="number"
      inputMode={isInteger ? "numeric" : "decimal"}
      step={isInteger ? 1 : "any"}
      min={field.schema.minimum}
      max={field.schema.maximum}
      value={value === undefined || value === null ? "" : String(value)}
      onChange={(event) => {
        const raw = event.target.value;
        onChange(raw === "" ? undefined : Number(raw));
      }}
    />
  );
}

function SliderWidget({ field, value, onChange }: WidgetProps) {
  const min = field.schema.minimum ?? 0;
  const max = field.schema.maximum ?? 100;
  const isInteger = field.schema.type === "integer";
  const step = isInteger ? 1 : (max - min) / 100 || 0.01;
  const current = typeof value === "number" ? value : (field.schema.default as number) ?? min;

  return (
    <div className="slider-row">
      <input
        className="field-slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={current}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <input
        className="field-input slider-number"
        type="number"
        min={min}
        max={max}
        step={step}
        value={current}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

function BooleanWidget({ value, onChange }: WidgetProps) {
  const checked = value === true;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`switch ${checked ? "is-on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-thumb" />
      <span className="switch-label">{checked ? "On" : "Off"}</span>
    </button>
  );
}

function FileWidget({ field, value, onChange, mode }: WidgetProps & { mode: "base64" | "bytes" }) {
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const contentType = typeof field.schema.contentType === "string" ? field.schema.contentType : "";
  const accept = contentType || guessAccept(field.name);

  const handle = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      onChange(mode === "base64" ? await fileToBase64(file) : await fileToBytes(file));
      setName(`${file.name} · ${formatBytes(file.size)}`);
    } finally {
      setBusy(false);
    }
  };

  const hasValue = Array.isArray(value) ? value.length > 0 : typeof value === "string" && value !== "";

  return (
    <div className="file-widget">
      <label className="file-drop">
        <input
          type="file"
          accept={accept}
          onChange={(event) => void handle(event.target.files?.[0])}
        />
        <span>{busy ? "Reading…" : hasValue ? "Replace file" : "Choose a file"}</span>
      </label>
      {name && (
        <div className="file-meta">
          <span className="mono">{name}</span>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              onChange(undefined);
              setName(null);
            }}
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

function guessAccept(name: string): string {
  if (/audio/.test(name)) return "audio/*";
  if (/video/.test(name)) return "video/*";
  if (/image/.test(name)) return "image/*";
  return "";
}

const ROLES = ["system", "user", "assistant"];

function MessagesWidget({ value, onChange }: WidgetProps) {
  const messages = Array.isArray(value)
    ? (value as Array<{ role?: string; content?: string }>)
    : [{ role: "user", content: "" }];

  const update = (index: number, patch: Partial<{ role: string; content: string }>) => {
    const next = messages.map((message, i) => (i === index ? { ...message, ...patch } : message));
    onChange(next);
  };

  return (
    <div className="messages-widget">
      {messages.map((message, index) => (
        <div className="message-row" key={index}>
          <div className="message-head">
            <select
              className="field-input message-role"
              value={message.role ?? "user"}
              onChange={(event) => update(index, { role: event.target.value })}
            >
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
            {messages.length > 1 && (
              <button
                type="button"
                className="link-button"
                onClick={() => onChange(messages.filter((_, i) => i !== index))}
              >
                Remove
              </button>
            )}
          </div>
          <AutoTextarea
            value={message.content ?? ""}
            onChange={(content) => update(index, { content })}
            placeholder={message.role === "system" ? "System instructions…" : "Message…"}
          />
        </div>
      ))}
      <button
        type="button"
        className="secondary-button small"
        onClick={() => onChange([...messages, { role: "user", content: "" }])}
      >
        + Add message
      </button>
    </div>
  );
}

function JsonWidget({ value, onChange }: WidgetProps) {
  const [text, setText] = useState(() => (value === undefined ? "" : JSON.stringify(value, null, 2)));
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <AutoTextarea
        value={text}
        rows={4}
        placeholder="JSON value"
        onChange={(next) => {
          setText(next);
          if (next.trim() === "") {
            setError(null);
            onChange(undefined);
            return;
          }
          try {
            onChange(JSON.parse(next));
            setError(null);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      />
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}

/** Repeatable rows for arrays of objects that are not chat messages. */
function ArrayWidget({ field, value, onChange }: WidgetProps) {
  const items = Array.isArray(value) ? value : [];
  const itemSchema = field.schema.items ?? {};

  if (!itemSchema.properties) {
    return <JsonWidget field={field} value={value} onChange={onChange} />;
  }

  return (
    <div className="array-widget">
      {items.map((item, index) => (
        <div className="array-item" key={index}>
          <div className="array-item-head">
            <span className="array-index">#{index + 1}</span>
            <button
              type="button"
              className="link-button"
              onClick={() => onChange(items.filter((_, i) => i !== index))}
            >
              Remove
            </button>
          </div>
          <FieldList
            schema={itemSchema}
            values={(item ?? {}) as Record<string, unknown>}
            onChange={(next) => onChange(items.map((entry, i) => (i === index ? next : entry)))}
          />
        </div>
      ))}
      <button
        type="button"
        className="secondary-button small"
        onClick={() => onChange([...items, {}])}
      >
        + Add item
      </button>
    </div>
  );
}

function ObjectWidget({ field, value, onChange }: WidgetProps) {
  return (
    <div className="object-widget">
      <FieldList
        schema={field.schema}
        values={(value ?? {}) as Record<string, unknown>}
        onChange={(next) => onChange(next)}
      />
    </div>
  );
}

function Widget(props: WidgetProps) {
  switch (props.field.widget) {
    case "enum":
      return <EnumWidget {...props} />;
    case "textarea":
      return (
        <AutoTextarea
          value={typeof props.value === "string" ? props.value : ""}
          onChange={props.onChange}
          placeholder={props.field.schema.description ? undefined : humanize(props.field.name)}
        />
      );
    case "text":
      return (
        <input
          className="field-input"
          type="text"
          value={typeof props.value === "string" ? props.value : ""}
          onChange={(event) => props.onChange(event.target.value)}
        />
      );
    case "number":
      return <NumberWidget {...props} />;
    case "slider":
      return <SliderWidget {...props} />;
    case "boolean":
      return <BooleanWidget {...props} />;
    case "file-base64":
      return <FileWidget {...props} mode="base64" />;
    case "file-bytes":
      return <FileWidget {...props} mode="bytes" />;
    case "messages":
      return <MessagesWidget {...props} />;
    case "array":
      return <ArrayWidget {...props} />;
    case "object":
      return <ObjectWidget {...props} />;
    default:
      return <JsonWidget {...props} />;
  }
}

// ---------------------------------------------------------------------------
// Field layout
// ---------------------------------------------------------------------------

function FieldRow({
  field,
  value,
  onChange,
}: {
  field: Field;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const isWide = field.widget === "messages" || field.widget === "array" || field.widget === "object";
  return (
    <div className={`field ${isWide ? "field-wide" : ""}`}>
      <div className="field-label-row">
        <label className="field-label">
          {humanize(field.name)}
          {field.required && <span className="required-dot" title="Required">*</span>}
        </label>
        <code className="field-name">{field.name}</code>
      </div>
      {field.schema.description && <p className="field-help">{field.schema.description}</p>}
      <Widget field={field} value={value} onChange={onChange} />
    </div>
  );
}

function FieldList({
  schema,
  values,
  onChange,
}: {
  schema: JsonSchema;
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
}) {
  const fields = getFields(schema);
  return (
    <>
      {fields.map((field) => (
        <FieldRow
          key={field.name}
          field={field}
          value={values[field.name]}
          onChange={(next) => {
            const updated = { ...values };
            if (next === undefined) delete updated[field.name];
            else updated[field.name] = next;
            onChange(updated);
          }}
        />
      ))}
    </>
  );
}

/**
 * Required fields sit in the open; everything else hides behind an "Advanced"
 * disclosure so a text-to-image model opens showing just a prompt box.
 */
export function SchemaForm({
  schema,
  values,
  onChange,
}: {
  schema: JsonSchema;
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const fields = getFields(schema);
  const required = fields.filter((f) => f.required);
  const optional = fields.filter((f) => !f.required);

  const setValue = (name: string, next: unknown) => {
    const updated = { ...values };
    if (next === undefined) delete updated[name];
    else updated[name] = next;
    onChange(updated);
  };

  if (!fields.length) {
    return <p className="empty-note">This model declares no input fields. Use the JSON editor below.</p>;
  }

  return (
    <div className="schema-form">
      {required.map((field) => (
        <FieldRow key={field.name} field={field} value={values[field.name]} onChange={(v) => setValue(field.name, v)} />
      ))}

      {optional.length > 0 && (
        <div className="advanced">
          <button
            type="button"
            className="advanced-toggle"
            aria-expanded={showAdvanced}
            onClick={() => setShowAdvanced((open) => !open)}
          >
            <span className={`chevron ${showAdvanced ? "open" : ""}`} aria-hidden="true" />
            Advanced
            <span className="count-pill">{optional.length}</span>
          </button>
          {showAdvanced && (
            <div className="advanced-body">
              {optional.map((field) => (
                <FieldRow
                  key={field.name}
                  field={field}
                  value={values[field.name]}
                  onChange={(v) => setValue(field.name, v)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export { pickWidget };
