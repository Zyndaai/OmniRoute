import test from "node:test";
import assert from "node:assert/strict";

import {
  clusterConfigErrors,
  getInstanceId,
  getRole,
  resolveBootPlan,
} from "../../../src/lib/cluster/role.ts";

const CLUSTER_ENV = {
  REDIS_URL: "redis://redis:6379",
  OMNIROUTE_INSTANCE_ID: "omniroute-1",
  JWT_SECRET: "jwt",
  API_KEY_SECRET: "key",
};

test("role: unset or empty is standalone; leader/worker are case-insensitive", () => {
  assert.equal(getRole({}), "standalone");
  assert.equal(getRole({ OMNIROUTE_ROLE: "  " }), "standalone");
  assert.equal(getRole({ OMNIROUTE_ROLE: "Leader" }), "leader");
  assert.equal(getRole({ OMNIROUTE_ROLE: " worker " }), "worker");
});

test("role: an unknown value throws instead of defaulting", () => {
  assert.throws(() => getRole({ OMNIROUTE_ROLE: "leeder" }), /not a valid role/);
});

test("instance id: invalid or missing falls back to standalone", () => {
  assert.equal(getInstanceId({ OMNIROUTE_INSTANCE_ID: "omniroute-2" }), "omniroute-2");
  assert.equal(getInstanceId({ OMNIROUTE_INSTANCE_ID: "has space" }), "standalone");
  assert.equal(getInstanceId({}), "standalone");
});

test("boot plan matrix", () => {
  const cases: Array<[string, Record<string, string>, Record<string, boolean>]> = [
    [
      "standalone keeps today's duties and takes the fence (a second one exits)",
      {},
      {
        applyMigrations: true,
        leaderDuties: true,
        backgroundJobs: true,
        optionalSubsystems: true,
        generateSecrets: true,
        takeLeaderFence: true,
      },
    ],
    [
      "standalone honours the background and headless flags",
      { OMNIROUTE_DISABLE_BACKGROUND_SERVICES: "1", OMNIROUTE_HEADLESS: "true" },
      { leaderDuties: true, backgroundJobs: false, optionalSubsystems: false },
    ],
    [
      "leader",
      { ...CLUSTER_ENV, OMNIROUTE_ROLE: "leader" },
      {
        applyMigrations: true,
        leaderDuties: true,
        backgroundJobs: true,
        optionalSubsystems: true,
        generateSecrets: false,
        takeLeaderFence: true,
      },
    ],
    [
      "worker only serves requests",
      { ...CLUSTER_ENV, OMNIROUTE_ROLE: "worker" },
      {
        applyMigrations: false,
        leaderDuties: false,
        backgroundJobs: false,
        optionalSubsystems: false,
        generateSecrets: false,
        takeLeaderFence: false,
      },
    ],
  ];
  for (const [name, env, expected] of cases) {
    const plan = resolveBootPlan(env);
    for (const [field, value] of Object.entries(expected)) {
      assert.equal(plan[field as keyof typeof plan], value, `${name}: ${field}`);
    }
  }
});

test("coordination: PostgreSQL by default, Redis when REDIS_URL is set", () => {
  assert.equal(resolveBootPlan({}).coordination, "postgres");
  assert.equal(resolveBootPlan({ OMNIROUTE_ROLE: "worker" }).coordination, "postgres");
  assert.equal(resolveBootPlan({ REDIS_URL: "redis://redis:6379" }).coordination, "redis");
  assert.equal(resolveBootPlan({ REDIS_URL: "  " }).coordination, "postgres");
});

test("cluster config errors: none in standalone, all missing pieces in cluster mode", () => {
  assert.deepEqual(clusterConfigErrors({}), []);
  assert.deepEqual(clusterConfigErrors({ ...CLUSTER_ENV, OMNIROUTE_ROLE: "worker" }), []);
  // Redis is optional: PostgreSQL carries the coordination without it.
  const { REDIS_URL: _unused, ...withoutRedis } = CLUSTER_ENV;
  assert.deepEqual(clusterConfigErrors({ ...withoutRedis, OMNIROUTE_ROLE: "leader" }), []);

  const errors = clusterConfigErrors({ OMNIROUTE_ROLE: "leader" });
  assert.equal(errors.length, 3);
  assert.ok(errors.some((e) => e.startsWith("OMNIROUTE_INSTANCE_ID")));
  assert.ok(errors.some((e) => e.startsWith("JWT_SECRET")));
  assert.ok(errors.some((e) => e.startsWith("API_KEY_SECRET")));

  assert.match(clusterConfigErrors({ OMNIROUTE_ROLE: "boss" })[0], /not a valid role/);
});
