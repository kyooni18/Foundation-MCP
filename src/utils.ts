import { createHash, timingSafeEqual } from "node:crypto";

export function normalizeContent(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}


export function normalizeNamespace(value: string): string {
  const namespace = normalizeContent(value);
  if (!namespace) throw new Error("namespace must not be empty");
  if (namespace.length > 200) throw new Error("namespace exceeds 200 characters");
  if (namespace.includes("\n")) throw new Error("namespace must be a single line");
  return namespace;
}

export function normalizeOptionalText(
  value: string | null | undefined,
  field: string,
  maxLength: number
): string | null | undefined {
  if (value === undefined || value === null) return value;
  const normalized = normalizeContent(value);
  if (normalized.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters`);
  return normalized || null;
}

export function normalizeTag(value: string): string {
  return value.normalize("NFC").trim().toLocaleLowerCase("und").replace(/\s+/g, "-");
}

export function normalizeTags(values: string[] = []): string[] {
  const tags = [...new Set(values.map(normalizeTag).filter(Boolean))].sort();
  if (tags.length > 100) throw new Error("tags exceeds 100 entries");
  if (tags.some(tag => tag.length > 100)) throw new Error("each tag must be at most 100 characters");
  return tags;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function parseOptionalDate(value: string | null | undefined, field: string): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${field} must be an ISO-8601 timestamp`);
  return date;
}

export function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

export function vectorLiteral(vector: number[]): string {
  if (vector.length === 0 || vector.some(value => !Number.isFinite(value))) {
    throw new Error("Embedding must contain finite numeric values");
  }
  return `[${vector.join(",")}]`;
}

export function secureTokenEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function jsonText(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item instanceof Date ? item.toISOString() : item, 2);
}

export function compactRecord(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return value ?? {};
}

const MAX_RECORD_BYTES = 4_096;
const MAX_RECORD_DEPTH = 4;
const MAX_RECORD_KEYS = 50;
const MAX_RECORD_ITEMS = 50;
const MAX_RECORD_STRING = 1_000;

export function boundedRecord(value: Record<string, unknown> | undefined, field: string): Record<string, unknown> {
  const walk = (item: unknown, depth: number): unknown => {
    if (typeof item === "string") {
      if (item.length > MAX_RECORD_STRING) throw new Error(`${field} contains a string exceeding ${MAX_RECORD_STRING} characters`);
      return item;
    }
    if (item === null || typeof item === "number" || typeof item === "boolean") return item;
    if (depth >= MAX_RECORD_DEPTH) throw new Error(`${field} exceeds maximum nesting depth of ${MAX_RECORD_DEPTH}`);
    if (Array.isArray(item)) {
      if (item.length > MAX_RECORD_ITEMS) throw new Error(`${field} contains an array exceeding ${MAX_RECORD_ITEMS} items`);
      return item.map(entry => walk(entry, depth + 1));
    }
    if (typeof item === "object") {
      const entries = Object.entries(item as Record<string, unknown>);
      if (entries.length > MAX_RECORD_KEYS) throw new Error(`${field} exceeds ${MAX_RECORD_KEYS} keys at one level`);
      return Object.fromEntries(entries.map(([key, entry]) => [key, walk(entry, depth + 1)]));
    }
    throw new Error(`${field} contains an unsupported value`);
  };

  const result = walk(value ?? {}, 0) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_RECORD_BYTES) {
    throw new Error(`${field} exceeds ${MAX_RECORD_BYTES} bytes`);
  }
  return result;
}

export function safeIndexDimension(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 16_000) {
    throw new Error("EMBEDDING_DIMENSIONS must be an integer between 1 and 16000");
  }
  return value;
}
