import { getDbBackend } from "./backends/selection";
import type { DbBackend, DbExecutor } from "./backends/types";

/**
 * The one entry point domain modules use for SQL. Every module under
 * `src/lib/db/` (and the few outside it that own a table) writes PostgreSQL
 * against `migrations/0001_init.sql` through these helpers; nothing else opens
 * a connection.
 *
 * Conventions:
 * - Placeholders are `$1, $2, …`; never build SQL from values.
 * - Inside `db().transaction(async (tx) => …)` use `tx`, never `db()`.
 * - Rows come back with numbers for bigint/numeric, ISO strings for
 *   timestamptz, `YYYY-MM-DD` for date, booleans for boolean and parsed
 *   objects for jsonb (see `backends/postgres/typeParsers.ts`).
 */
export function db(): DbBackend {
  return getDbBackend();
}

export type { DbBackend, DbExecutor };

/**
 * A jsonb parameter. node-postgres turns a JS array into a Postgres array
 * literal and an object into JSON text; passing the JSON string always works
 * and keeps arrays as JSON arrays. `undefined` becomes SQL NULL.
 */
export function jsonb(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/**
 * A timestamptz parameter from the shapes the code passes today: Date, ISO or
 * `YYYY-MM-DD HH:MM:SS` (UTC) strings, epoch milliseconds or epoch seconds.
 * Returns an ISO string, or null for null/undefined/empty/invalid input.
 */
export function ts(value: Date | string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    // Below 1e11 is seconds (that is year 5138 in ms); the code stores both.
    return new Date(value < 1e11 ? value * 1000 : value).toISOString();
  }
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return ts(Number(trimmed));
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(trimmed)
    ? `${trimmed.replace(" ", "T")}Z`
    : trimmed;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Epoch milliseconds for a timestamp column value (ISO string), or null. */
export function toMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
