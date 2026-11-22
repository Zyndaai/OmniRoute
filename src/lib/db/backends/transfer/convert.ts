/**
 * Value conversion for the SQLite -> PostgreSQL transfer, driven by the target column's type
 * (`docs/architecture/postgres-schema-mapping.md` -> "General conversion rules").
 *
 * Every converter returns either the value to bind or a `Problem` that the caller logs and
 * resolves (column default, NULL, skip the row, or abort the table). Values bound to the
 * database and values fed to the digest come from the same converted row, so a conversion that
 * the database stores differently shows up as a digest mismatch.
 */

export interface TargetColumn {
  name: string;
  /** `udt_name` from information_schema: timestamptz, int4, _int2, jsonb, ... */
  udt: string;
  notNull: boolean;
  /** The column has a DEFAULT (or is an identity), so `DEFAULT` can stand in for a NULL. */
  hasDefault: boolean;
  identity: boolean;
  /** numeric scale, when the type is numeric(p, s). */
  numericScale: number | null;
  /** Allowed values when a CHECK constrains the column to a fixed list. */
  allowed: ReadonlySet<string> | null;
}

export type ProblemKind =
  | "unparseable-timestamp"
  | "invalid-json"
  | "invalid-number"
  | "not-a-uuid"
  | "int-out-of-range"
  | "nul-stripped"
  | "not-in-allowed-set"
  | "invalid-time"
  | "invalid-date";

export interface Problem {
  problem: ProblemKind;
  /** The value to use anyway (e.g. NUL-stripped text); absent when nothing usable remains. */
  fallback?: unknown;
}

export const isProblem = (value: unknown): value is Problem =>
  typeof value === "object" && value !== null && "problem" in value;

const INT_LIMITS: Record<string, [number, number]> = {
  int2: [-32768, 32767],
  int4: [-2147483648, 2147483647],
  int8: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
};

// Epoch values outside this window are not real event times (0, small counters, garbage).
const MIN_EPOCH_MS = Date.UTC(2000, 0, 1);
const MAX_EPOCH_MS = Date.UTC(2100, 0, 1);

const SQLITE_DATETIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const HOUR_KEY = /^(\d{4}-\d{2}-\d{2})T(\d{2})$/;
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME_HHMM = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

/** Strips U+0000, which PostgreSQL rejects in text and jsonb. */
export function stripNul(value: string): string {
  return value.includes("\u0000") ? value.replaceAll("\u0000", "") : value;
}

function stripNulDeep(value: unknown): { value: unknown; stripped: boolean } {
  let stripped = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (!v.includes("\u0000")) return v;
      stripped = true;
      return v.replaceAll("\u0000", "");
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[walk(k) as string] = walk(val);
      return out;
    }
    return v;
  };
  return { value: walk(value), stripped };
}

/**
 * An instant from any of the formats the SQLite writers used, as a `Date`; null for empty.
 * Numbers (and numeric strings) are epoch milliseconds when >= 1e11, else seconds — the
 * mapping's TS-mix rule, which also holds for every TS-ms / TS-s column at real-world values.
 */
export function parseInstant(value: unknown): Date | null | Problem {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  let ms: number;
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())
        ? Number(value)
        : null;
  if (numeric !== null) {
    ms = Math.abs(numeric) >= 1e11 ? numeric : numeric * 1000;
  } else if (typeof value === "string") {
    const text = value.trim();
    const hour = HOUR_KEY.exec(text);
    const sqlite = SQLITE_DATETIME.exec(text);
    if (hour) ms = Date.parse(`${hour[1]}T${hour[2]}:00:00Z`);
    else if (DATE_ONLY.test(text)) ms = Date.parse(`${text}T00:00:00Z`);
    // `datetime('now')` / CURRENT_TIMESTAMP text and zone-less ISO are UTC, never local time.
    else if (sqlite && !HAS_ZONE.test(text)) ms = Date.parse(`${sqlite[1]}T${sqlite[2]}Z`);
    else ms = Date.parse(text);
  } else {
    return { problem: "unparseable-timestamp" };
  }
  if (!Number.isFinite(ms) || ms < MIN_EPOCH_MS || ms >= MAX_EPOCH_MS) {
    return { problem: "unparseable-timestamp" };
  }
  return new Date(ms);
}

function toBoolean(value: unknown): boolean | null | Problem {
  if (value === null || value === undefined) return null;
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  return { problem: "invalid-number" };
}

function toJson(value: unknown): unknown | Problem {
  if (value === null || value === undefined) return null;
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return { problem: "invalid-json" };
    }
  } else if (Buffer.isBuffer(value)) {
    return { problem: "invalid-json" };
  }
  const { value: clean, stripped } = stripNulDeep(parsed);
  return stripped ? { problem: "nul-stripped", fallback: { json: clean } } : { json: clean };
}

/** Rounds `value` to `scale` decimals as an exact decimal string. */
export function toDecimalString(value: number, scale: number | null): string {
  if (scale === null) return String(value);
  return value.toFixed(scale);
}

/**
 * A stored SQLite number for a numeric column: null for empty, a Problem for text that is not a
 * number. (Not the app's `toNumber`: that coerces with a fallback, while the transfer must log
 * every value it cannot carry over.)
 */
function parseNumericCell(value: unknown): number | null | Problem {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  if (typeof value === "bigint") return Number(value);
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : { problem: "invalid-number" };
}

/**
 * Converts one SQLite value for `column`. Returns the bind value (`{ json }` wraps jsonb values
 * so JSON null and SQL NULL stay distinct), null, or a Problem.
 */
export function convertValue(value: unknown, column: TargetColumn): unknown {
  if (value === undefined) return null;
  const { udt } = column;

  let out: unknown;
  switch (udt) {
    case "timestamptz": {
      const instant = parseInstant(value);
      out = instant instanceof Date ? instant.toISOString() : instant;
      break;
    }
    case "date": {
      if (value === null || value === "") return null;
      if (typeof value === "string" && DATE_ONLY.test(value.trim())) return value.trim();
      const instant = parseInstant(value);
      out = instant instanceof Date ? instant.toISOString().slice(0, 10) : instant;
      if (isProblem(out)) out = { problem: "invalid-date" };
      break;
    }
    case "time": {
      if (value === null || value === "") return null;
      out =
        typeof value === "string" && TIME_HHMM.test(value.trim())
          ? value.trim()
          : { problem: "invalid-time" };
      break;
    }
    case "bool":
      out = toBoolean(value);
      break;
    case "jsonb":
    case "json":
      out = toJson(value);
      break;
    case "numeric": {
      const n = parseNumericCell(value);
      out = typeof n === "number" ? toDecimalString(n, column.numericScale) : n;
      break;
    }
    case "float4":
    case "float8":
      out = parseNumericCell(value);
      break;
    case "int2":
    case "int4":
    case "int8": {
      const n = parseNumericCell(value);
      if (typeof n !== "number") {
        out = n;
        break;
      }
      const rounded = Math.round(n);
      const [lo, hi] = INT_LIMITS[udt];
      out =
        rounded < lo || rounded > hi
          ? { problem: "int-out-of-range", fallback: Math.min(hi, Math.max(lo, rounded)) }
          : rounded;
      break;
    }
    case "uuid":
      if (value === null || value === "") return null;
      out =
        typeof value === "string" && UUID.test(value)
          ? value.toLowerCase()
          : { problem: "not-a-uuid" };
      break;
    case "bytea":
      if (value === null) return null;
      out = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
      break;
    case "text":
    case "varchar":
    case "bpchar": {
      if (value === null) return null;
      const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
      const clean = stripNul(text);
      out = clean === text ? clean : { problem: "nul-stripped", fallback: clean };
      break;
    }
    case "_int2":
    case "_int4":
    case "_int8": {
      if (value === null || value === "") return null;
      const parts = Array.isArray(value)
        ? value
        : String(value).trim().startsWith("[")
          ? (toJson(value) as { json: unknown[] }).json
          : String(value).split(",");
      const nums = (parts ?? []).map((p) => Number(String(p).trim()));
      out = nums.every((n) => Number.isInteger(n)) ? nums : { problem: "invalid-number" };
      break;
    }
    case "_timestamptz": {
      if (value === null || value === "") return null;
      const parsed = toJson(value);
      if (isProblem(parsed) || !Array.isArray((parsed as { json: unknown }).json)) {
        out = { problem: "invalid-json" };
        break;
      }
      const instants = (parsed as { json: unknown[] }).json.map((v) => parseInstant(v));
      out = instants.every((d) => d instanceof Date)
        ? instants.map((d) => (d as Date).toISOString())
        : { problem: "unparseable-timestamp" };
      break;
    }
    default:
      throw new Error(`transfer: no converter for column type ${udt} (${column.name})`);
  }

  if (!isProblem(out) && out !== null && column.allowed) {
    const text = typeof out === "string" ? out : String(out);
    if (!column.allowed.has(text)) return { problem: "not-in-allowed-set", fallback: out };
  }
  return out;
}
