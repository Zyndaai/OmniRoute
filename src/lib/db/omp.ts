import os from "os";
import path from "path";
import { createRequire } from "node:module";

// oh-my-pi keeps its credentials in its own SQLite file (~/.omp/agent/agent.db), not in
// OmniRoute's database, so it is opened with better-sqlite3 directly. The synchronous
// callers need a synchronous load; Reflect keeps the request dynamic so bundlers leave the
// native package external.
const runtimeRequire = createRequire(process.argv[1] || process.cwd());

type DatabaseConstructor = typeof import("better-sqlite3");

function getDatabaseClass(): DatabaseConstructor | null {
  try {
    return Reflect.apply(runtimeRequire, undefined, ["better-sqlite3"]) as DatabaseConstructor;
  } catch {
    return null;
  }
}

function databaseOptions(readonly = false) {
  return readonly ? { readonly: true } : {};
}

const getOmpDir = () => path.join(os.homedir(), ".omp", "agent");
const getOmpDbPath = () => path.join(getOmpDir(), "agent.db");

export function getOmpCredentials(providerId: string) {
  const Database = getDatabaseClass();
  if (!Database) return { hasOmniRoute: false, baseUrl: null, apiKey: null };
  const dbPath = getOmpDbPath();
  try {
    const db = new Database(dbPath, databaseOptions(true));
    let row: { data: string } | undefined;
    try {
      row = db
        .prepare(
          "SELECT data FROM auth_credentials WHERE provider = ? AND credential_type = 'api_key'"
        )
        .get(providerId) as { data: string } | undefined;
    } finally {
      // Close even when the query throws (e.g. missing table): a leaked handle locks the file
      // on Windows.
      db.close();
    }

    if (row?.data) {
      const parsed = JSON.parse(row.data);
      return { hasOmniRoute: true, baseUrl: parsed.baseUrl || null, apiKey: parsed.apiKey || null };
    }
    return { hasOmniRoute: false, baseUrl: null, apiKey: null };
  } catch {
    return { hasOmniRoute: false, baseUrl: null, apiKey: null };
  }
}

export function saveOmpCredentials(providerId: string, apiKey: string, baseUrl: string) {
  const Database = getDatabaseClass();
  if (!Database) return;
  const dbPath = getOmpDbPath();
  const db = new Database(dbPath, databaseOptions());

  db.prepare("DELETE FROM auth_credentials WHERE provider = ?").run(providerId);
  db.prepare(
    "INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause, identity_key, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, ?)"
  ).run(
    providerId,
    "api_key",
    JSON.stringify({ apiKey, baseUrl }),
    Math.floor(Date.now() / 1000),
    Math.floor(Date.now() / 1000)
  );

  db.close();
}

export function deleteOmpCredentials(providerId: string) {
  const Database = getDatabaseClass();
  if (!Database) return;
  const dbPath = getOmpDbPath();
  const db = new Database(dbPath, databaseOptions());
  db.prepare("DELETE FROM auth_credentials WHERE provider = ?").run(providerId);
  db.close();
}
