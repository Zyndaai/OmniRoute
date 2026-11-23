/**
 * Gateway API keys with STORAGE_ENCRYPTION_KEY unset (passthrough mode).
 *
 * Mirrors `encryptConnectionFields`: without an encryption key the `api_keys.key` column
 * stays plaintext — but authentication must still resolve the caller by `key_hash` only,
 * and a legacy row with `key_hash` NULL must get its hash on first use.
 *
 * Kept as its own file because the encryption module reads the key once per process.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-apikey-passthrough-"));
process.env.DATA_DIR = TEST_DATA_DIR;
delete process.env.STORAGE_ENCRYPTION_KEY;
process.env.API_KEY_SECRET = "synthetic-apikey-passthrough-api-key-secret";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";

const core = await import("../../../src/lib/db/core.ts");
const { getTestBackend } = await import("../../helpers/postgres.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const { opaqueTokenFingerprint } = await import("../../../open-sse/utils/opaqueTokenFingerprint.ts");

type Row = Record<string, unknown>;

async function keyRow(id: string): Promise<Row> {
  const row = await getTestBackend().queryOne<Row>(
    "SELECT id, key, key_hash, key_prefix FROM api_keys WHERE id = $1",
    [id]
  );
  assert.ok(row, `api key ${id} must exist`);
  return row;
}

async function insertRow(id: string, key: string, keyHash: string) {
  await getTestBackend().execute(
    "INSERT INTO api_keys (id, name, key, machine_id, created_at, key_hash, key_prefix) VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7)",
    [id, id, key, "machine-pt", "2024-01-01T00:00:00.000Z", keyHash, key.slice(0, 12)]
  );
  apiKeysDb.clearApiKeyCaches();
}

test.after(async () => {
  apiKeysDb.resetApiKeyState();
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("without an encryption key the column stays plaintext and the key still authenticates", async () => {
  const created = await apiKeysDb.createApiKey("pt-key", "machine-pt", []);
  const row = await keyRow(created.id);
  assert.equal(row.key, created.key, "passthrough mode keeps the column as written");
  assert.equal(row.key_hash, opaqueTokenFingerprint(created.key));
  assert.equal(await apiKeysDb.validateApiKey(created.key), true);
  assert.equal(((await apiKeysDb.getApiKeyById(created.id)) as Row).key, created.key);
});

test("authentication is hash-only even in passthrough mode", async () => {
  const plainSecret = "sk-synthetic-pt-plain-column-only";
  const hashedSecret = "sk-synthetic-pt-hashed-secret-only";
  await insertRow("pt-hash-only", plainSecret, opaqueTokenFingerprint(hashedSecret));

  assert.equal(await apiKeysDb.validateApiKey(plainSecret), false, "plaintext match must not auth");
  assert.equal(await apiKeysDb.validateApiKey(hashedSecret), true, "hash match must auth");
});

// The former "legacy row with key_hash NULL gets its hash on first use" case is gone:
// api_keys.key_hash is NOT NULL (hash-format CHECK) in PostgreSQL, so such a row cannot exist.
