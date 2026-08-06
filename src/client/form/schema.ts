import type { JsonSchema } from "../../shared/types";

/**
 * Pure helpers that turn a model's input JSON Schema into something a form can
 * render. Kept free of React so the mapping rules stay easy to reason about.
 */

export type WidgetKind =
  | "enum"
  | "textarea"
  | "text"
  | "number"
  | "slider"
  | "boolean"
  | "file-base64"
  | "file-bytes"
  | "messages"
  | "array"
  | "object"
  | "json";

/** Field names that hold prose and deserve a textarea rather than an input. */
const PROSE_FIELDS = new Set([
  "prompt",
  "text",
  "input",
  "input_text",
  "system",
  "system_prompt",
  "negative_prompt",
  "content",
  "message",
  "query",
  "instructions",
  "description",
  "target",
  "source",
]);

function typeOf(schema: JsonSchema): string {
  const type = schema.type;
  if (Array.isArray(type)) return type.find((t) => t !== "null") ?? "string";
  return type ?? inferType(schema);
}

/** Some entries omit `type` and are only identifiable by their other keywords. */
function inferType(schema: JsonSchema): string {
  if (schema.properties) return "object";
  if (schema.items) return "array";
  if (schema.enum) return "string";
  return "string";
}

function isBinaryString(name: string, schema: JsonSchema): boolean {
  const contentType = typeof schema.contentType === "string" ? schema.contentType : "";
  if (/^(image|audio|video)\//.test(contentType)) return true;
  if (schema.format === "binary" || schema.format === "byte" || schema.format === "base64") return true;
  return /^(image|audio|video|file|attachment)(_b64|_base64)?$/.test(name);
}

export function pickWidget(name: string, schema: JsonSchema): WidgetKind {
  if (Array.isArray(schema.enum) && schema.enum.length) return "enum";

  switch (typeOf(schema)) {
    case "boolean":
      return "boolean";

    case "integer":
    case "number":
      return typeof schema.minimum === "number" && typeof schema.maximum === "number"
        ? "slider"
        : "number";

    case "string": {
      if (isBinaryString(name, schema)) return "file-base64";
      const longByConstraint = typeof schema.maxLength === "number" && schema.maxLength > 512;
      if (PROSE_FIELDS.has(name) || longByConstraint) return "textarea";
      return "text";
    }

    case "array": {
      const items = schema.items ?? {};
      const itemType = typeOf(items);
      // Whisper-style audio is delivered as an array of byte values.
      if (itemType === "integer" || itemType === "number") return "file-bytes";
      if (itemType === "object") return name === "messages" ? "messages" : "array";
      return "array";
    }

    case "object":
      return schema.properties ? "object" : "json";

    default:
      return "json";
  }
}

export interface Variant {
  label: string;
  schema: JsonSchema;
}

/**
 * Text-generation schemas commonly present a `oneOf` choice between a plain
 * `prompt` and a `messages` array. Surface those as switchable variants instead
 * of collapsing them into one confusing form.
 */
export function getVariants(root: JsonSchema): Variant[] {
  const branches = root.oneOf ?? root.anyOf;
  if (!Array.isArray(branches) || branches.length < 2) {
    return [{ label: "Default", schema: root }];
  }

  return branches.map((branch, index) => ({
    label: variantLabel(branch, index),
    schema: mergeVariant(root, branch),
  }));
}

function variantLabel(branch: JsonSchema, index: number): string {
  if (typeof branch.title === "string" && branch.title.trim()) return branch.title;
  const required = branch.required?.[0];
  if (required) return required.charAt(0).toUpperCase() + required.slice(1);
  const first = branch.properties ? Object.keys(branch.properties)[0] : undefined;
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : `Option ${index + 1}`;
}

/** Fields declared on the root apply to every branch. */
function mergeVariant(root: JsonSchema, branch: JsonSchema): JsonSchema {
  return {
    ...branch,
    type: "object",
    properties: { ...(root.properties ?? {}), ...(branch.properties ?? {}) },
    required: [...(root.required ?? []), ...(branch.required ?? [])],
  };
}

export interface Field {
  name: string;
  schema: JsonSchema;
  required: boolean;
  widget: WidgetKind;
}

/** Required fields first, then declaration order — the order people fill them in. */
export function getFields(schema: JsonSchema): Field[] {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);

  const fields = Object.entries(properties).map(([name, fieldSchema]) => ({
    name,
    schema: fieldSchema,
    required: required.has(name),
    widget: pickWidget(name, fieldSchema),
  }));

  return fields.sort((a, b) => Number(b.required) - Number(a.required));
}

/**
 * Seeds initial values from explicit `default`s only.
 *
 * Deliberately does not invent values for unset optional fields — sending a
 * parameter a model did not ask for is a good way to get a 400 back.
 */
export function initialValues(schema: JsonSchema): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of getFields(schema)) {
    if (field.schema.default !== undefined) {
      values[field.name] = field.schema.default;
    } else if (field.required) {
      values[field.name] = emptyValueFor(field);
    }
  }
  return values;
}

function emptyValueFor(field: Field): unknown {
  // A required dropdown with no default should land on its first option rather
  // than render as an empty select the user has to notice.
  if (field.widget === "enum") return field.schema.enum?.[0];

  switch (field.widget) {
    case "boolean":
      return false;
    case "messages":
      return [{ role: "user", content: "" }];
    case "array":
      return [];
    case "object":
      return {};
    case "number":
    case "slider":
      return field.schema.minimum ?? 0;
    default:
      return "";
  }
}

/** Drops empty optionals so the request carries only what was actually set. */
export function pruneValues(
  values: Record<string, unknown>,
  schema: JsonSchema,
): Record<string, unknown> {
  const required = new Set(schema.required ?? []);
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(values)) {
    if (required.has(key)) {
      output[key] = value;
      continue;
    }
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    output[key] = value;
  }
  return output;
}

/** Names of required fields the user has not filled in yet. */
export function missingRequired(
  values: Record<string, unknown>,
  schema: JsonSchema,
): string[] {
  return (schema.required ?? []).filter((name) => {
    const value = values[name];
    if (value === undefined || value === null) return true;
    if (typeof value === "string" && value.trim() === "") return true;
    if (Array.isArray(value) && value.length === 0) return true;
    return false;
  });
}

/** Turns `max_tokens` into `Max tokens` for labels. */
export function humanize(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bId\b/, "ID")
    .replace(/\bUrl\b/, "URL");
}
