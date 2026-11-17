import { classifyPgError } from "./errors";
import type { DbBackend, DbExecutor } from "../types";

export interface PgQueryResult {
  // pg returns untyped rows; repositories pick the row type via query<T>().
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rows: any[];
  rowCount: number | null;
}

export interface PgPoolClientLike {
  query(text: string, values?: unknown[]): Promise<PgQueryResult>;
  release(err?: unknown): void;
}

/** Satisfied by a real `pg.Pool` and by the PGlite adapter (see pglite.ts). */
export interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<PgQueryResult>;
  connect?(): Promise<PgPoolClientLike>;
  end?(): Promise<void>;
}

interface Queryable {
  query(text: string, values?: unknown[]): Promise<PgQueryResult>;
}

function toExecutor(target: Queryable): DbExecutor {
  const run = async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
    try {
      return await target.query(sql, params ? [...params] : undefined);
    } catch (err) {
      throw classifyPgError(err);
    }
  };
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      return (await run(sql, params)).rows as T[];
    },
    async queryOne<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      return (await run(sql, params)).rows[0] as T | undefined;
    },
    async execute(sql: string, params?: readonly unknown[]) {
      return { changes: (await run(sql, params)).rowCount ?? 0 };
    },
  };
}

export function createPostgresBackend(client: PgClientLike): DbBackend {
  const root = toExecutor(client);

  return {
    kind: "postgres",
    ...root,

    async transaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
      if (!client.connect) throw classifyPgError(new Error("Postgres client cannot connect()"));
      const conn: PgPoolClientLike = await client.connect().catch((err: unknown) => {
        throw classifyPgError(err);
      });
      const tx = toExecutor(conn);
      let releaseError: unknown;
      try {
        await tx.execute("BEGIN");
        const result = await fn(tx);
        await tx.execute("COMMIT");
        return result;
      } catch (err) {
        try {
          await conn.query("ROLLBACK");
        } catch (rollbackErr) {
          // A connection that cannot roll back is unusable: make the pool discard it.
          releaseError = rollbackErr;
        }
        // Statements on `tx` already throw DbBackendError; anything else is the
        // caller's own error (a domain error, a validation failure) and must
        // reach the caller unchanged.
        throw err;
      } finally {
        conn.release(releaseError);
      }
    },

    async health() {
      try {
        await client.query("SELECT 1");
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: classifyPgError(err).message };
      }
    },

    async close() {
      await client.end?.();
    },
  };
}
