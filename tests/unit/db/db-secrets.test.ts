import test from "node:test";
import assert from "node:assert/strict";

import { getTestBackend, resetTestDb } from "../../helpers/postgres.ts";

const secretsDb = await import("../../../src/lib/db/secrets.ts");

test.beforeEach(async () => {
  await resetTestDb();
});

test("getPersistedSecret returns null for missing keys", async () => {
  assert.equal(await secretsDb.getPersistedSecret("missing"), null);
});

test("persistSecret stores and reads secrets from the config_entries table", async () => {
  await secretsDb.persistSecret("oauth_token", "secret-value");

  assert.equal(await secretsDb.getPersistedSecret("oauth_token"), "secret-value");
});

test("persistSecret does not overwrite an existing secret because storage is insert-only", async () => {
  await secretsDb.persistSecret("api_token", "first-value");
  await secretsDb.persistSecret("api_token", "second-value");

  assert.equal(await secretsDb.getPersistedSecret("api_token"), "first-value");
});

test("malformed persisted rows are treated as missing secrets", async () => {
  // config_entries.value is jsonb: a stored value that is not a JSON string (here an object)
  // is a malformed secret row and must read as missing.
  await getTestBackend().execute(
    "INSERT INTO config_entries (namespace, key, value) VALUES ('secrets', 'broken', $1::jsonb)",
    [JSON.stringify({ not: "a secret string" })]
  );

  assert.equal(await secretsDb.getPersistedSecret("broken"), null);
});
