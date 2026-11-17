import type { PgClientLike, PgPoolClientLike, PgQueryResult } from "./postgresBackend";

/** The slice of `@electric-sql/pglite` this adapter needs (keeps the dependency type-only). */
export interface PgliteLike {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; affectedRows?: number }>;
  exec(text: string): Promise<Array<{ rows: unknown[]; affectedRows?: number }>>;
  close(): Promise<void>;
}

/**
 * Adapts PGlite (one in-process connection) to PgClientLike. `connect()` hands
 * out the single connection under a mutex so two transactions never interleave;
 * pool-level `query()` waits for any open transaction, the held client does not.
 */
export function fromPglite(db: PgliteLike): PgClientLike {
  let tail: Promise<void> = Promise.resolve();

  const run = async (text: string, values?: unknown[]): Promise<PgQueryResult> => {
    if (values && values.length > 0) {
      const res = await db.query(text, values);
      return { rows: res.rows, rowCount: res.affectedRows ?? null };
    }
    // exec() uses the simple protocol, so multi-statement migration files work.
    const results = await db.exec(text);
    const last = results[results.length - 1];
    return { rows: last?.rows ?? [], rowCount: last?.affectedRows ?? null };
  };

  const acquire = (): Promise<() => void> => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const ready = tail.then(() => release);
    tail = tail.then(() => gate);
    return ready;
  };

  return {
    async query(text, values) {
      const release = await acquire();
      try {
        return await run(text, values);
      } finally {
        release();
      }
    },
    async connect(): Promise<PgPoolClientLike> {
      const release = await acquire();
      return {
        query: run,
        release: () => release(),
      };
    },
    async end() {
      await db.close();
    },
  };
}
