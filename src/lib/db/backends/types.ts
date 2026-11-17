/**
 * Internal async backend contract used ONLY by repository implementations
 * (see docs/architecture/persistence-backend-boundary.md). Business code
 * depends on domain repositories, never on this surface.
 *
 * Each repository implementation writes SQL for its own dialect (SQLite keeps
 * `?` / `@name`, Postgres uses `$1, $2`); a backend passes params through
 * untouched.
 */

export type DbBackendKind = "sqlite" | "postgres";

export interface DbExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  queryOne<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<T | undefined>;
  execute(sql: string, params?: readonly unknown[]): Promise<{ changes: number }>;
}

export interface DbBackend extends DbExecutor {
  readonly kind: DbBackendKind;
  /**
   * Runs `fn` atomically. Repositories MUST use the `tx` they are given for
   * every statement inside; calling `transaction` on the backend from inside
   * `fn` is not supported (SQLite would deadlock on its single connection).
   * Nested `tx.*` calls reuse the same connection.
   */
  transaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T>;
  health(): Promise<{ ok: boolean; detail?: string }>;
  close(): Promise<void>;
}

export type DbBackendErrorKind =
  | "retryable"
  | "unique_violation"
  | "foreign_key_violation"
  | "not_null_violation"
  | "unavailable"
  | "other";

export class DbBackendError extends Error {
  readonly kind: DbBackendErrorKind;
  readonly code?: string;
  readonly cause?: unknown;

  constructor(
    kind: DbBackendErrorKind,
    message: string,
    options: { code?: string; cause?: unknown } = {}
  ) {
    super(message);
    this.name = "DbBackendError";
    this.kind = kind;
    this.code = options.code;
    this.cause = options.cause;
  }
}
