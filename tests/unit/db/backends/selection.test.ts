import test from "node:test";
import assert from "node:assert/strict";

import {
  getDbBackend,
  initDbBackend,
  resetDbBackendForTests,
  resolvePoolMax,
} from "../../../../src/lib/db/backends/selection.ts";

test("pool size defaults to 10 and accepts OMNIROUTE_PG_POOL_MAX between 1 and 100", () => {
  assert.equal(resolvePoolMax(undefined), 10);
  assert.equal(resolvePoolMax("20"), 20);
  assert.equal(resolvePoolMax(" 1 "), 1);
  for (const bad of ["0", "-3", "101", "4.5", "lots", ""]) assert.equal(resolvePoolMax(bad), 10);
});

const savedEnv = { ...process.env };
const savedBackend = globalThis.__omnirouteDbBackend;
function restoreEnv() {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  globalThis.__omnirouteDbBackend = savedBackend;
}

test("missing OMNIROUTE_POSTGRES_URL throws", () => {
  delete process.env.OMNIROUTE_POSTGRES_URL;
  try {
    resetDbBackendForTests();
    assert.throws(() => getDbBackend(), /OMNIROUTE_POSTGRES_URL/);
  } finally {
    restoreEnv();
  }
});

test("a failed startup health check never leaks the password", async () => {
  process.env.OMNIROUTE_POSTGRES_URL = "postgres://omni:s3cr3t-pw@127.0.0.1:1/omni";
  try {
    resetDbBackendForTests();
    await assert.rejects(
      () => initDbBackend(),
      (err: Error) => {
        assert.match(err.message, /PostgreSQL health check failed/);
        assert.ok(!err.message.includes("s3cr3t-pw"));
        assert.ok(!err.message.includes("127.0.0.1"));
        return true;
      }
    );
  } finally {
    restoreEnv();
  }
});

test("the backend is a process singleton", () => {
  process.env.OMNIROUTE_POSTGRES_URL = "postgres://omni:pw@127.0.0.1:1/omni";
  try {
    resetDbBackendForTests();
    const a = getDbBackend();
    assert.equal(a.kind, "postgres");
    assert.equal(getDbBackend(), a);
    void a.close();
  } finally {
    restoreEnv();
  }
});
