import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// DB-backed access-token store. Uses an isolated DATA_DIR + closes the pool in
// test.after (CLAUDE.md "Database Handles in Tests" — otherwise Node's runner hangs).
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-access-tokens-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { getTestBackend } = await import("../helpers/postgres.ts");
const at = await import("../../src/lib/db/accessTokens.ts");

test.after(async () => {
  try {
    await core.resetDbInstance();
  } catch {}
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
});

test("createAccessToken returns a secret prefixed oma_live_ and a masked record", async () => {
  const { record, secret } = await at.createAccessToken({ name: "laptop", scope: "write" });
  assert.match(secret, /^oma_live_/);
  assert.equal(record.name, "laptop");
  assert.equal(record.scope, "write");
  assert.ok(record.id.startsWith("tok_"));
  assert.ok(secret.startsWith(record.tokenPrefix), "prefix must be a prefix of the secret");
  assert.equal(record.revokedAt, null);
});

test("createAccessToken defaults to the safest scope (read) for invalid input", async () => {
  const { record } = await at.createAccessToken({ name: "x", scope: "bogus" });
  assert.equal(record.scope, "read");
});

test("createAccessToken rejects an empty name", async () => {
  await assert.rejects(at.createAccessToken({ name: "   ", scope: "read" }), /name is required/);
});

test("verifyAccessToken returns identity+scope for a valid secret, null for wrong", async () => {
  const { secret } = await at.createAccessToken({ name: "verify-me", scope: "admin" });
  const v = await at.verifyAccessToken(secret);
  assert.ok(v);
  assert.equal(v?.scope, "admin");
  assert.equal(v?.name, "verify-me");
  assert.equal(await at.verifyAccessToken("oma_live_wrong"), null);
  assert.equal(await at.verifyAccessToken(""), null);
  assert.equal(await at.verifyAccessToken(null), null);
});

test("only the hash is stored — the plaintext secret never lands in the DB", async () => {
  const { secret, record } = await at.createAccessToken({ name: "secrecy", scope: "read" });
  const row = (await getTestBackend().queryOne(
    "SELECT token_hash, token_prefix FROM cli_access_tokens WHERE id = $1",
    [record.id]
  )) as { token_hash: string; token_prefix: string };
  assert.notEqual(row.token_hash, secret, "must store hash, not plaintext");
  assert.equal(row.token_hash, at.hashAccessToken(secret));
  assert.equal(row.token_hash.length, 64, "sha-256 hex");
});

test("verifyAccessToken stamps last_used_at", async () => {
  const { secret, record } = await at.createAccessToken({ name: "touch", scope: "read" });
  assert.equal((await at.getAccessToken(record.id))?.lastUsedAt, null);
  await at.verifyAccessToken(secret);
  assert.notEqual((await at.getAccessToken(record.id))?.lastUsedAt, null);
});

test("verifyAccessToken writes last_used_at once per window", async () => {
  const { secret, record } = await at.createAccessToken({ name: "throttle", scope: "read" });
  const backend = getTestBackend();
  let writes = 0;
  const originalExecute = backend.execute.bind(backend);
  backend.execute = ((sql: string, params?: readonly unknown[]) => {
    if (/UPDATE\s+cli_access_tokens\s+SET\s+last_used_at/i.test(sql)) writes += 1;
    return originalExecute(sql, params);
  }) as typeof backend.execute;

  try {
    assert.ok(await at.verifyAccessToken(secret));
    assert.ok(await at.verifyAccessToken(secret));
    assert.equal(writes, 1, "a repeat verify inside the window must not write again");
    assert.notEqual((await at.getAccessToken(record.id))?.lastUsedAt, null);

    const stale = new Date(Date.now() - 61_000).toISOString();
    await originalExecute("UPDATE cli_access_tokens SET last_used_at = $1 WHERE id = $2", [
      stale,
      record.id,
    ]);
    assert.ok(await at.verifyAccessToken(secret));
    assert.equal(writes, 2, "a stamp older than the window must be refreshed");
    assert.notEqual((await at.getAccessToken(record.id))?.lastUsedAt, stale);
  } finally {
    backend.execute = originalExecute;
  }
});

test("revoked tokens fail verification", async () => {
  const { secret, record } = await at.createAccessToken({ name: "to-revoke", scope: "write" });
  assert.ok(await at.verifyAccessToken(secret));
  const first = await at.revokeAccessToken(record.id);
  assert.equal(first.revoked, true);
  assert.equal(first.alreadyRevoked, false);
  assert.equal(await at.verifyAccessToken(secret), null);
  // A retry after a lost response must not look like a miss.
  const second = await at.revokeAccessToken(record.id);
  assert.equal(second.revoked, true);
  assert.equal(second.alreadyRevoked, true);
  assert.notEqual((await at.getAccessToken(record.id))?.revokedAt, null);
});

test("revokeAccessToken works by display prefix too", async () => {
  const { secret, record } = await at.createAccessToken({ name: "by-prefix", scope: "read" });
  const result = await at.revokeAccessToken(record.tokenPrefix);
  assert.equal(result.revoked, true);
  assert.equal(result.alreadyRevoked, false);
  assert.equal(await at.verifyAccessToken(secret), null);
});

test("revoke by a shared prefix refuses instead of revoking every match", async () => {
  const first = await at.createAccessToken({ name: "shared-a", scope: "read" });
  const second = await at.createAccessToken({ name: "shared-b", scope: "write" });
  await getTestBackend().execute("UPDATE cli_access_tokens SET token_prefix = $1 WHERE id = $2", [
    first.record.tokenPrefix,
    second.record.id,
  ]);

  const result = await at.revokeAccessToken(first.record.tokenPrefix);
  assert.equal(result.revoked, false);
  assert.equal(result.ambiguous, true);
  assert.equal((await at.getAccessToken(first.record.id))?.revokedAt, null);
  assert.equal((await at.getAccessToken(second.record.id))?.revokedAt, null);
  // The id is unique, so the same collision does not block an id revoke.
  assert.equal((await at.revokeAccessToken(first.record.id)).revoked, true);
  assert.equal((await at.getAccessToken(second.record.id))?.revokedAt, null);
});

test("revoke by prefix ignores already-revoked siblings", async () => {
  const live = await at.createAccessToken({ name: "live-sibling", scope: "read" });
  const dead = await at.createAccessToken({ name: "dead-sibling", scope: "write" });
  await getTestBackend().execute(
    "UPDATE cli_access_tokens SET token_prefix = $1, revoked_at = $2 WHERE id = $3",
    [live.record.tokenPrefix, new Date().toISOString(), dead.record.id]
  );

  const result = await at.revokeAccessToken(live.record.tokenPrefix);
  assert.equal(result.revoked, true);
  assert.equal(result.ambiguous, false);
  assert.notEqual((await at.getAccessToken(live.record.id))?.revokedAt, null);
});

test("revoke by prefix of an already-revoked unique prefix reports alreadyRevoked", async () => {
  const { record } = await at.createAccessToken({ name: "prefix-retry", scope: "read" });
  assert.equal((await at.revokeAccessToken(record.tokenPrefix)).alreadyRevoked, false);
  const retry = await at.revokeAccessToken(record.tokenPrefix);
  assert.equal(retry.revoked, true);
  assert.equal(retry.alreadyRevoked, true);
  assert.equal(retry.ambiguous, false);
});

test("revoke of an unknown id is not a success", async () => {
  const result = await at.revokeAccessToken("tok_does_not_exist");
  assert.equal(result.revoked, false);
  assert.equal(result.alreadyRevoked, false);
  assert.equal(result.ambiguous, false);
});

test("expired tokens fail verification", async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const { secret } = await at.createAccessToken({
    name: "expired",
    scope: "admin",
    expiresAt: past,
  });
  assert.equal(await at.verifyAccessToken(secret), null);
});

test("listAccessTokens returns masked records (no secret/hash field)", async () => {
  await at.createAccessToken({ name: "listed", scope: "read" });
  const list = await at.listAccessTokens();
  assert.ok(list.length >= 1);
  for (const rec of list) {
    assert.ok("tokenPrefix" in rec);
    assert.ok(!("secret" in rec));
    assert.ok(!("tokenHash" in rec));
    assert.ok(!("token_hash" in rec));
  }
});
