import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

import {
  markServerStarting,
  markServerReady,
  markServerStopping,
} from "../../../src/lib/serverLifecycle.ts";
import { isAuthzPath } from "../../../src/server/http/authzPaths.ts";

const livez = await import("../../../src/app/livez/route.ts");
const healthz = await import("../../../src/app/healthz/route.ts");

test("/livez is 200 while starting and stopping; /healthz stays lifecycle", async () => {
  markServerStarting();

  const startingLive = await livez.GET();
  assert.equal(startingLive.status, 200);
  assert.equal(await startingLive.text(), "ok\n");
  const startingReady = await healthz.GET();
  assert.equal(startingReady.status, 503);

  markServerReady();
  const readyLive = await livez.GET();
  assert.equal(readyLive.status, 200);
  assert.equal(readyLive.headers.get("Cache-Control"), "no-store");
  assert.equal(readyLive.headers.get("Content-Type"), "text/plain; charset=utf-8");
  assert.equal(await readyLive.text(), "ok\n");

  const readyHead = await livez.HEAD();
  assert.equal(readyHead.status, 200);
  assert.equal(await readyHead.text(), "");

  markServerStopping();
  const stoppingLive = await livez.GET();
  assert.equal(stoppingLive.status, 200);
  const stoppingReady = await healthz.GET();
  assert.equal(stoppingReady.status, 503);
});

test("/livez source does not import monitoring or sqlite helpers", () => {
  const source = fs.readFileSync("src/app/livez/route.ts", "utf8");
  assert.equal(/monitoring/i.test(source), false);
  assert.equal(/sqlite/i.test(source), false);
  assert.equal(source.includes("getServerLifecyclePhase"), false);
});

test("/livez is omitted from the centralized authz pipeline", () => {
  assert.equal(isAuthzPath("/livez"), false);
  assert.equal(isAuthzPath("/healthz"), false);
});
