// `provider_connections.provider_specific_data`: the declared secret fields
// (PROVIDER_SPECIFIC_SECRET_FIELDS) are enveloped by encryptConnectionFields on every
// full-row write and decrypted on every read (#16863). This file covers what that leaves
// open: list-valued secrets (the `extraApiKeys` rotation pool), refresh-flow sub-tokens
// (`copilotToken`), web-session cookies, the one-shot sweep of rows that were already on
// disk in plaintext, and patches written through mergeConnectionProviderSpecificData.
// With no STORAGE_ENCRYPTION_KEY the column stays plaintext, exactly like `api_key` does.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(
  path.join(process.env.DATA_DIR || os.tmpdir(), "omniroute-psd-secrets-at-rest-")
);
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.APP_LOG_TO_FILE = "false";
process.env.STORAGE_ENCRYPTION_KEY = "psd-secrets-at-rest-synthetic-key";

const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");
const { looksEncrypted, isEncryptionEnabled } = await import("../../../src/lib/db/encryption.ts");
const providers = await import("../../../src/lib/db/providers.ts");
const { ensureProviderSpecificDataSecretsEncrypted } =
  await import("../../../src/lib/db/providers/migrations.ts");
const { mergeConnectionProviderSpecificData } =
  await import("../../../src/lib/db/providers/providerSpecificDataMerge.ts");
const { invalidateDbCache } = await import("../../../src/lib/db/readCache.ts");

const ENC_PREFIX = "enc:v1:";
const PRIMARY_KEY = "sk-primary-0123456789abcdefghij";
// The apikey create path dedups by key value (#3023): every created fixture gets its own key.
const uniqueKey = (label: string) => `${PRIMARY_KEY}-${label}`;
const EXTRA_ONE = "sk-extra-one-0123456789abcdefgh";
const EXTRA_TWO = "sk-extra-two-0123456789abcdefgh";
const COPILOT_TOKEN = "ghu_copilotbearer_0123456789abcdef";
const GROK_COOKIE = "sso=grok-sso-0123456789; sso-rw=grok-sso-rw-0123456789";

type Row = { provider_specific_data: string | null; api_key: string | null };
type Psd = Record<string, unknown>;

/**
 * The raw column as stored. jsonb comes back as an object from the driver, so it is
 * re-serialized here: the assertions below look for plaintext secrets in the stored text.
 */
async function rawRow(id: string): Promise<Row> {
  const row = await getTestBackend().queryOne<{
    provider_specific_data: unknown;
    api_key: string | null;
  }>("SELECT provider_specific_data, api_key FROM provider_connections WHERE id = $1", [id]);
  assert.ok(row, `row ${id} must exist`);
  const psd = row.provider_specific_data;
  return {
    api_key: row.api_key,
    provider_specific_data: psd === null || psd === undefined ? null : JSON.stringify(psd),
  };
}

async function rawPsd(id: string): Promise<Psd> {
  const row = await rawRow(id);
  assert.ok(row.provider_specific_data, "provider_specific_data must be stored");
  return JSON.parse(row.provider_specific_data) as Psd;
}

function psdOf(connection: unknown): Psd {
  const psd = (connection as { providerSpecificData?: unknown } | null)?.providerSpecificData;
  assert.ok(psd && typeof psd === "object", "providerSpecificData must be present");
  return psd as Psd;
}

async function insertLegacyPlaintextRow(id: string, psd: Psd) {
  const now = new Date().toISOString();
  await getTestBackend().execute(
    `INSERT INTO provider_connections
       (id, provider, auth_type, name, priority, is_active, api_key, provider_specific_data, created_at, updated_at)
     VALUES ($1, 'openai', 'apikey', $2, 1, true, $3, $4::jsonb, $5, $6)`,
    [id, `legacy-${id}`, PRIMARY_KEY, JSON.stringify(psd), now, now]
  );
  invalidateDbCache("connections");
}

async function createPool(label: string, providerSpecificData: Psd) {
  const created = (await providers.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: label,
    apiKey: uniqueKey(label),
    providerSpecificData,
  })) as Record<string, unknown> & { id: string };
  assert.ok(typeof created.id === "string" && created.id.length > 0);
  return created;
}

test.before(async () => {
  await resetTestDb();
  assert.equal(isEncryptionEnabled(), true, "precondition: synthetic STORAGE_ENCRYPTION_KEY");
});

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  delete process.env.STORAGE_ENCRYPTION_KEY;
});

// The sweep runs once per database backend (WeakMap in providers/migrations.ts), so this case
// must be the first providers call in this process: it is ordered first in the file.
test("first use of the providers module sweeps rows still holding plaintext secrets (idempotent)", async () => {
  const id = "legacy-sweep-row";
  await insertLegacyPlaintextRow(id, {
    extraApiKeys: [EXTRA_ONE, EXTRA_TWO],
    copilotToken: COPILOT_TOKEN,
    tags: ["keep"],
  });
  await createPool("already", { extraApiKeys: [EXTRA_ONE] });

  // Trigger the module's first read on this database instance.
  const connections = await providers.getProviderConnections({ provider: "openai" });
  assert.ok(connections.length >= 1);

  const sweptColumn = (await rawRow(id)).provider_specific_data ?? "";
  for (const secret of [EXTRA_ONE, EXTRA_TWO, COPILOT_TOKEN]) {
    assert.ok(!sweptColumn.includes(secret), `sweep left ${secret.slice(0, 12)}… in plaintext`);
  }
  const swept = JSON.parse(sweptColumn) as Psd;
  assert.deepEqual(swept.tags, ["keep"]);
  for (const entry of swept.extraApiKeys as string[]) assert.ok(entry.startsWith(ENC_PREFIX));
  assert.ok(String(swept.copilotToken).startsWith(ENC_PREFIX));

  const readBack = await providers.getProviderConnectionById(id);
  assert.deepEqual(psdOf(readBack).extraApiKeys, [EXTRA_ONE, EXTRA_TWO]);
  assert.equal(psdOf(readBack).copilotToken, COPILOT_TOKEN);

  // Rows that were already encrypted are left exactly as they were (no re-wrap), and a
  // second pass is a no-op.
  const alreadyRows = await getTestBackend().query<{ id: string }>(
    "SELECT id FROM provider_connections WHERE name = 'already'"
  );
  assert.equal(alreadyRows.length, 1);
  const before = (await rawRow(alreadyRows[0].id)).provider_specific_data;
  await providers.getProviderConnections({ provider: "openai" });
  assert.equal((await rawRow(alreadyRows[0].id)).provider_specific_data, before);
  // The pass is memoized per backend: a second call returns the same pass, never re-wraps.
  await ensureProviderSpecificDataSecretsEncrypted();
  assert.equal((await rawRow(alreadyRows[0].id)).provider_specific_data, before);
});

test("createProviderConnection envelopes every extraApiKeys entry and the copilot sub-token", async () => {
  const created = await createPool("pool", {
    extraApiKeys: [EXTRA_ONE, EXTRA_TWO],
    copilotToken: COPILOT_TOKEN,
    tags: ["pool"],
    baseUrl: "https://api.example.test/v1",
  });

  // The object handed back to the caller is still plaintext.
  assert.deepEqual(psdOf(created).extraApiKeys, [EXTRA_ONE, EXTRA_TWO]);
  assert.equal(psdOf(created).copilotToken, COPILOT_TOKEN);

  const row = await rawRow(created.id);
  assert.ok(looksEncrypted(row.api_key), "control: api_key is encrypted as before");
  const column = row.provider_specific_data ?? "";
  for (const secret of [EXTRA_ONE, EXTRA_TWO, COPILOT_TOKEN]) {
    assert.ok(
      !column.includes(secret),
      `provider_specific_data stores ${secret.slice(0, 12)}… in plaintext`
    );
  }
  const stored = JSON.parse(column) as Psd;
  assert.ok(Array.isArray(stored.extraApiKeys) && stored.extraApiKeys.length === 2);
  for (const entry of stored.extraApiKeys as unknown[]) {
    assert.ok(
      typeof entry === "string" && entry.startsWith(ENC_PREFIX),
      "each extra key is enveloped"
    );
  }
  assert.ok(String(stored.copilotToken).startsWith(ENC_PREFIX), "copilotToken is enveloped");
  assert.deepEqual(stored.tags, ["pool"], "non-secret fields stay plaintext JSON");
  assert.equal(stored.baseUrl, "https://api.example.test/v1");

  // Every module read path returns plaintext.
  const byId = await providers.getProviderConnectionById(created.id);
  assert.deepEqual(psdOf(byId).extraApiKeys, [EXTRA_ONE, EXTRA_TWO]);
  assert.equal(psdOf(byId).copilotToken, COPILOT_TOKEN);

  const listed = (await providers.getProviderConnections({ provider: "openai" })).find(
    (c) => c.id === created.id
  );
  assert.ok(listed);
  assert.deepEqual(psdOf(listed).extraApiKeys, [EXTRA_ONE, EXTRA_TWO]);
  // The export path serializes the lazy view — still plaintext.
  const exported = JSON.parse(JSON.stringify(listed)) as Record<string, unknown>;
  assert.deepEqual(psdOf(exported).extraApiKeys, [EXTRA_ONE, EXTRA_TWO]);
});

test("updateProviderConnection envelopes a plaintext list and never double-encrypts it", async () => {
  const created = await createPool("pool-update", { extraApiKeys: [EXTRA_ONE] });

  // A metadata-only update must not disturb the stored secrets.
  const before = (await rawPsd(created.id)).extraApiKeys;
  await providers.updateProviderConnection(created.id, { name: "renamed" });
  assert.deepEqual((await rawPsd(created.id)).extraApiKeys, before, "ciphertext untouched by a rename");
  assert.deepEqual(psdOf(await providers.getProviderConnectionById(created.id)).extraApiKeys, [
    EXTRA_ONE,
  ]);

  // A providerSpecificData update with plaintext input lands encrypted.
  await providers.updateProviderConnection(created.id, {
    providerSpecificData: { extraApiKeys: [EXTRA_ONE, EXTRA_TWO], tags: ["x"] },
  });
  const entries = (await rawPsd(created.id)).extraApiKeys as string[];
  assert.equal(entries.length, 2);
  for (const entry of entries) assert.ok(entry.startsWith(ENC_PREFIX));
  // Exactly one envelope per value: decrypting once yields the token itself.
  assert.deepEqual(psdOf(await providers.getProviderConnectionById(created.id)).extraApiKeys, [
    EXTRA_ONE,
    EXTRA_TWO,
  ]);
});

test("mergeConnectionProviderSpecificData envelopes the secret fields of a patch", async () => {
  const created = await createPool("merge-patch", { extraApiKeys: [EXTRA_ONE], tags: ["keep"] });
  const poolBefore = (await rawPsd(created.id)).extraApiKeys;

  // What the GHE Copilot executor does after minting a bearer: patch the token in place.
  await mergeConnectionProviderSpecificData(created.id, {
    copilotToken: COPILOT_TOKEN,
    copilotTokenExpiresAt: 1_900_000_000,
  });

  const column = (await rawRow(created.id)).provider_specific_data ?? "";
  assert.ok(!column.includes(COPILOT_TOKEN), "the patched token must not land in plaintext");
  const stored = JSON.parse(column) as Psd;
  assert.ok(String(stored.copilotToken).startsWith(ENC_PREFIX), "copilotToken is enveloped");
  assert.equal(stored.copilotTokenExpiresAt, 1_900_000_000, "non-secret patch keys stay plain");
  assert.deepEqual(stored.tags, ["keep"], "existing non-secret fields are preserved");
  assert.deepEqual(stored.extraApiKeys, poolBefore, "existing ciphertext is not re-wrapped");

  const readBack = await providers.getProviderConnectionById(created.id);
  assert.equal(psdOf(readBack).copilotToken, COPILOT_TOKEN);
  assert.deepEqual(psdOf(readBack).extraApiKeys, [EXTRA_ONE]);
});

test("web-session cookie dedup still matches the stored (now encrypted) credential", async () => {
  const first = (await providers.createProviderConnection({
    provider: "grok-web",
    authType: "cookie",
    name: "grok-a",
    providerSpecificData: { cookie: GROK_COOKIE, sso: "grok-sso-0123456789" },
  })) as Record<string, unknown> & { id: string };
  const column = (await rawRow(first.id)).provider_specific_data ?? "";
  assert.ok(!column.includes(GROK_COOKIE), "the cookie is encrypted at rest");
  assert.ok(!column.includes("grok-sso-0123456789"), "the sso token is encrypted at rest");

  const second = (await providers.createProviderConnection({
    provider: "grok-web",
    authType: "cookie",
    name: "grok-b",
    providerSpecificData: { cookie: GROK_COOKIE, sso: "grok-sso-0123456789" },
  })) as Record<string, unknown>;
  assert.equal(second.id, first.id, "re-importing the same session updates the existing row");
  assert.equal(await providers.getProviderConnectionsCount({ provider: "grok-web" }), 1);
});

test("without STORAGE_ENCRYPTION_KEY the column stays plaintext, like api_key", async () => {
  const saved = process.env.STORAGE_ENCRYPTION_KEY;
  delete process.env.STORAGE_ENCRYPTION_KEY;
  try {
    assert.equal(isEncryptionEnabled(), false);
    const created = await createPool("plain-mode", { extraApiKeys: [EXTRA_ONE] });
    const row = await rawRow(created.id);
    assert.equal(row.api_key, uniqueKey("plain-mode"), "control: api_key passthrough");
    assert.deepEqual((await rawPsd(created.id)).extraApiKeys, [EXTRA_ONE]);
  } finally {
    process.env.STORAGE_ENCRYPTION_KEY = saved;
  }
});
