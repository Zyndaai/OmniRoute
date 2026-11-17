import test from "node:test";
import assert from "node:assert/strict";

import {
  getDbBackend,
  initDbBackend,
  resetDbBackendForTests,
} from "../../../../src/lib/db/backends/selection.ts";

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
