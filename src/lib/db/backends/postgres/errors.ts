import { DbBackendError, type DbBackendErrorKind } from "../types";

const RETRYABLE = new Set(["40001", "40P01", "55P03", "57014"]);
const CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "57P01",
  "57P02",
  "57P03",
]);

function kindFor(code: string | undefined): DbBackendErrorKind {
  if (!code) return "other";
  if (RETRYABLE.has(code)) return "retryable";
  if (code === "23505") return "unique_violation";
  if (code === "23503") return "foreign_key_violation";
  if (code === "23502") return "not_null_violation";
  if (CONNECTION_CODES.has(code) || code.startsWith("08")) return "unavailable";
  return "other";
}

/**
 * Maps a pg/PGlite error to a DbBackendError. The message is built from the
 * SQLSTATE and the server's own message only; never from parameter values or
 * connection strings (pg errors can carry both in `detail`/`stack`, so those
 * are not copied). `cause` keeps the original for debugging.
 */
export function classifyPgError(err: unknown): DbBackendError {
  if (err instanceof DbBackendError) return err;
  const e = (err ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : undefined;
  const kind = kindFor(code);
  const raw = typeof e.message === "string" ? e.message : "database error";
  // Connection errors from pg may embed host/user; keep only the code.
  const message =
    kind === "unavailable" ? `Postgres unavailable (${code ?? "unknown"})` : raw.slice(0, 300);
  return new DbBackendError(kind, message, { code, cause: err });
}
