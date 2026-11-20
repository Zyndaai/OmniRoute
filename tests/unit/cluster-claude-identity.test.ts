// Cluster-stable Claude identity: every OmniRoute process (PM2 leader + workers) must emit the
// same session id and device id for one account, or one account looks like several clients.
import test from "node:test";
import assert from "node:assert/strict";

const SECRET = "test-api-key-secret-for-identity";
const DAY = 86_400_000;

async function loadCopy(tag: string) {
  return import(`../../open-sse/executors/claudeIdentity.ts?copy=${tag}-${Date.now()}`);
}

function withSecret<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.API_KEY_SECRET;
  if (value === undefined) delete process.env.API_KEY_SECRET;
  else process.env.API_KEY_SECRET = value;
  return fn().finally(() => {
    if (saved === undefined) delete process.env.API_KEY_SECRET;
    else process.env.API_KEY_SECRET = saved;
  });
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("two processes (module copies) emit the same session id for an account", () =>
  withSecret(SECRET, async () => {
    const a = await loadCopy("a");
    const b = await loadCopy("b");
    const now = Date.UTC(2026, 10, 18, 12);
    const idA = a.getSessionId("token-account-1", now);
    assert.match(idA, UUID_V4);
    assert.equal(b.getSessionId("token-account-1", now), idA);
    assert.notEqual(a.getSessionId("token-account-2", now), idA, "accounts differ");
  }));

test("the session id rotates at the UTC day boundary and is stable within a day", () =>
  withSecret(SECRET, async () => {
    const mod = await loadCopy("day");
    const morning = Date.UTC(2026, 10, 18, 1);
    const evening = Date.UTC(2026, 10, 18, 23);
    assert.equal(mod.getSessionId("tok", morning), mod.getSessionId("tok", evening));
    assert.notEqual(
      mod.getSessionId("tok", evening),
      mod.getSessionId("tok", evening + 2 * 3600_000)
    );
    assert.notEqual(mod.getSessionId("tok", morning), mod.getSessionId("tok", morning + DAY));
  }));

test("the device id is per account (connection id), identical across processes and token refreshes", () =>
  withSecret(SECRET, async () => {
    const a = await loadCopy("dev-a");
    const b = await loadCopy("dev-b");
    const before = a.resolveCliUserID({}, "access-token-before-refresh", "connection-1");
    assert.match(before, /^[a-f0-9]{64}$/);
    assert.equal(b.resolveCliUserID({}, "access-token-after-refresh", "connection-1"), before);
    assert.notEqual(a.resolveCliUserID({}, "x", "connection-2"), before);
    // A device id stored on the connection still wins.
    const stored = "a".repeat(64);
    assert.equal(a.resolveCliUserID({ cliUserID: stored }, "x", "connection-1"), stored);
  }));

test("the secret is required for derivation; without it the per-process random ids remain", () =>
  withSecret(undefined, async () => {
    const a = await loadCopy("nosecret-a");
    const b = await loadCopy("nosecret-b");
    assert.notEqual(a.getSessionId("tok"), b.getSessionId("tok"));
    assert.equal(a.getSessionId("tok"), a.getSessionId("tok"), "still stable within a process");
  }));
