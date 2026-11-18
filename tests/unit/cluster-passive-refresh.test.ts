import test from "node:test";
import assert from "node:assert/strict";

import {
  isPassiveRefresh,
  resolvePassiveTokens,
} from "../../open-sse/services/tokenRefresh/passiveRefresh.ts";

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const result = fn();
    if (result instanceof Promise) return result.finally(restore);
    restore();
  } catch (error) {
    restore();
    throw error;
  }
}

// Fail-safe: on a worker everything is passive except the known non-rotating providers.
// github, cursor, qoder and clinepass accept a new refresh token when one comes back.
const ROTATING = [
  "claude",
  "codex",
  "openai",
  "kiro",
  "amazon-q",
  "cline",
  "clinepass",
  "kimi-coding",
  "gitlab-duo",
  "openference",
  "github",
  "cursor",
  "qoder",
];
const NON_ROTATING = ["antigravity", "agy", "gemini", "gemini-cli", "muse-code"];

test("worker: every provider is passive except the known non-rotating ones", () =>
  withEnv(
    { OMNIROUTE_ROLE: "worker", OMNIROUTE_TOKEN_REFRESH_PASSIVE_PROVIDERS: undefined },
    () => {
      for (const p of ROTATING) assert.equal(isPassiveRefresh(p), true, p);
      for (const p of NON_ROTATING) assert.equal(isPassiveRefresh(p), false, p);
      assert.equal(isPassiveRefresh(" Claude "), true);
      assert.equal(isPassiveRefresh(undefined), false);
    }
  ));

test("leader and standalone refresh everything themselves", () => {
  for (const role of ["leader", undefined]) {
    withEnv({ OMNIROUTE_ROLE: role, OMNIROUTE_TOKEN_REFRESH_PASSIVE_PROVIDERS: undefined }, () => {
      for (const p of [...ROTATING, ...NON_ROTATING])
        assert.equal(isPassiveRefresh(p), false, `${role}:${p}`);
    });
  }
});

test("the single-process Codex passive switch still works without a role", () =>
  withEnv({ OMNIROUTE_ROLE: undefined, OMNIROUTE_TOKEN_REFRESH_PASSIVE_PROVIDERS: "codex" }, () => {
    assert.equal(isPassiveRefresh("codex"), true);
    assert.equal(isPassiveRefresh("claude"), false);
  }));

const FUTURE = () => new Date(Date.now() + 3_600_000).toISOString();

test("adopts a newer stored token without asking the leader", async () => {
  let asked = 0;
  const tokens = await resolvePassiveTokens(
    { connectionId: "c1", accessToken: "old" },
    {
      readConnection: async () => ({ accessToken: "new", refreshToken: "r2", expiresAt: FUTURE() }),
      requestRefresh: () => asked++,
      waitMs: 10_000,
    }
  );
  assert.equal(tokens.accessToken, "new");
  assert.equal(tokens.refreshToken, "r2");
  assert.equal(asked, 0);
});

test("worker: asks the leader once, then adopts the token the leader stores", async () => {
  let clock = 0;
  let reads = 0;
  const asked: string[] = [];
  const tokens = await resolvePassiveTokens(
    { connectionId: "c1", accessToken: "old" },
    {
      readConnection: async () => {
        reads++;
        return reads < 3
          ? { accessToken: "old", expiresAt: new Date(1).toISOString() }
          : { accessToken: "fresh", expiresAt: FUTURE() };
      },
      requestRefresh: (id) => asked.push(id),
      waitMs: 10_000,
      pollMs: 500,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    }
  );
  assert.deepEqual(asked, ["c1"]);
  assert.equal(tokens.accessToken, "fresh");
});

test("a still-valid token (proactive refresh window) never waits or asks the leader", async () => {
  let asked = 0;
  let slept = 0;
  const tokens = await resolvePassiveTokens(
    { connectionId: "c1", accessToken: "current", expiresAt: FUTURE() },
    {
      readConnection: async () => ({ accessToken: "current", expiresAt: FUTURE() }),
      requestRefresh: () => asked++,
      waitMs: 10_000,
      sleep: async () => {
        slept++;
      },
    }
  );
  assert.deepEqual(tokens, { error: "refresh_disabled" });
  assert.equal(asked, 0);
  assert.equal(slept, 0);
});

test("gives up with refresh_disabled (never unrecoverable) after the wait", async () => {
  let clock = 0;
  const tokens = await resolvePassiveTokens(
    { connectionId: "c1", accessToken: "old" },
    {
      readConnection: async () => ({ accessToken: "old", expiresAt: new Date(1).toISOString() }),
      requestRefresh: () => {},
      waitMs: 2_000,
      pollMs: 500,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    }
  );
  assert.deepEqual(tokens, { error: "refresh_disabled" });
});

test("no connection id or a failing read is refresh_disabled", async () => {
  assert.deepEqual(await resolvePassiveTokens({ accessToken: "x" }), { error: "refresh_disabled" });
  assert.deepEqual(
    await resolvePassiveTokens(
      { connectionId: "c1" },
      {
        readConnection: async () => {
          throw new Error("db down");
        },
        waitMs: 0,
      }
    ),
    { error: "refresh_disabled" }
  );
});
