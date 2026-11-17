import os from "node:os";
import { createPgPool } from "./postgres/pool";
import { createPostgresBackend } from "./postgres/postgresBackend";
import { classifyPgError } from "./postgres/errors";
import type { DbBackend } from "./types";

const URL_ENV = "OMNIROUTE_POSTGRES_URL";

declare global {
  var __omnirouteDbBackend: DbBackend | undefined;
}

/** Process singleton over one pg pool. There is no other database. */
export function getDbBackend(): DbBackend {
  if (globalThis.__omnirouteDbBackend) return globalThis.__omnirouteDbBackend;
  const url = process.env[URL_ENV]?.trim();
  if (!url) throw new Error(`${URL_ENV} is required: OmniRoute stores its data in PostgreSQL.`);
  const instanceId = process.env.OMNIROUTE_INSTANCE_ID?.trim() || os.hostname();
  const backend = createPostgresBackend(createPgPool(url, { instanceId }));
  globalThis.__omnirouteDbBackend = backend;
  return backend;
}

/** Resolves the backend and fails startup if PostgreSQL is unreachable. */
export async function initDbBackend(): Promise<DbBackend> {
  const backend = getDbBackend();
  try {
    await backend.queryOne("SELECT 1");
  } catch (err) {
    const { kind, code } = classifyPgError(err);
    resetDbBackendForTests();
    await backend.close().catch(() => {});
    // Built from kind/code only: driver messages can echo connection details.
    throw new Error(
      `PostgreSQL health check failed (${kind}${code ? `, code ${code}` : ""}). Check ${URL_ENV}.`
    );
  }
  return backend;
}

export function resetDbBackendForTests(): void {
  globalThis.__omnirouteDbBackend = undefined;
}
