import pg from "pg";
import type { PgClientLike } from "./postgresBackend";
import { PG_TYPE_PARSERS } from "./typeParsers";

let typesConfigured = false;

function configureTypes(): void {
  if (typesConfigured) return;
  typesConfigured = true;
  for (const [oid, parse] of Object.entries(PG_TYPE_PARSERS)) {
    pg.types.setTypeParser(Number(oid), parse);
  }
}

export function createPgPool(
  url: string,
  options: { instanceId: string; max?: number }
): PgClientLike & { end(): Promise<void> } {
  configureTypes();
  const pool = new pg.Pool({
    connectionString: url,
    max: options.max ?? 4,
    application_name: `omniroute-${options.instanceId}`,
    // Sent as startup parameters, so every connection has them before its first query.
    statement_timeout: 5_000,
    idle_in_transaction_session_timeout: 10_000,
  });
  // An idle client dropping (server restart) must not crash the process.
  pool.on("error", () => {});
  return pool as unknown as PgClientLike & { end(): Promise<void> };
}
