// Regression for #6131: the IP filter config lived in memory only, so every
// restart (i.e. every OmniRoute update) reset it to Disabled + empty lists and
// blacklisted IPs were never actually blocked. This locks the fix:
//   1. configure/blacklist persists to the DB and survives a simulated restart;
//   2. after the restart the blacklisted IP is still blocked by checkIP.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-ipfilter-6131-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { resetTestDb } = await import("../helpers/postgres.ts");
const core = await import("../../src/lib/db/core.ts");
const ipFilter = await import("../../open-sse/services/ipFilter.ts");

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test.beforeEach(async () => {
  // Fresh DB per test + fresh in-memory module state.
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  ipFilter.resetIPFilter();
});

// Simulate an OmniRoute restart: the module's in-memory state is wiped (as it
// would be on a fresh import) but the DB file persists — exactly what happens
// across an update/restart.
function simulateRestart() {
  ipFilter.resetIPFilter();
}

test("#6131 blacklist + enabled survive a restart (persisted to DB)", async () => {
  await ipFilter.configureIPFilter({ enabled: true, mode: "blacklist" });
  await ipFilter.addToBlacklist("203.0.113.7");
  await ipFilter.addToBlacklist("198.51.100.42");

  simulateRestart();

  const cfg = await ipFilter.getIPFilterConfig();
  assert.equal(cfg.enabled, true, "enabled must persist across restart");
  assert.equal(cfg.mode, "blacklist");
  assert.deepEqual(cfg.blacklist.sort(), ["198.51.100.42", "203.0.113.7"]);
});

test("#6131 blacklisted IP is still blocked after a restart", async () => {
  await ipFilter.configureIPFilter({ enabled: true, mode: "blacklist" });
  await ipFilter.addToBlacklist("203.0.113.7");

  simulateRestart();

  assert.equal((await ipFilter.checkIP("203.0.113.7")).allowed, false);
  assert.equal((await ipFilter.checkIP("203.0.113.8")).allowed, true);
});

test("#6131 removing an IP and disabling also persist across restart", async () => {
  await ipFilter.configureIPFilter({ enabled: true, mode: "blacklist" });
  await ipFilter.addToBlacklist("203.0.113.7");
  await ipFilter.addToBlacklist("203.0.113.8");
  await ipFilter.removeFromBlacklist("203.0.113.7");
  await ipFilter.configureIPFilter({ enabled: false });

  simulateRestart();

  const cfg = await ipFilter.getIPFilterConfig();
  assert.equal(cfg.enabled, false);
  assert.deepEqual(cfg.blacklist, ["203.0.113.8"]);
  // Disabled → everything allowed regardless of the persisted blacklist.
  assert.equal((await ipFilter.checkIP("203.0.113.8")).allowed, true);
});

test("#6131 whitelist mode persists across restart", async () => {
  await ipFilter.configureIPFilter({ enabled: true, mode: "whitelist" });
  await ipFilter.addToWhitelist("203.0.113.7");

  simulateRestart();

  const cfg = await ipFilter.getIPFilterConfig();
  assert.equal(cfg.mode, "whitelist");
  assert.deepEqual(cfg.whitelist, ["203.0.113.7"]);
  assert.equal((await ipFilter.checkIP("203.0.113.7")).allowed, true);
  assert.equal((await ipFilter.checkIP("10.0.0.1")).allowed, false);
});

test("#6131 defaults are safe when nothing was ever persisted (disabled, allow-all)", async () => {
  simulateRestart();
  const cfg = await ipFilter.getIPFilterConfig();
  assert.equal(cfg.enabled, false);
  assert.deepEqual(cfg.blacklist, []);
  assert.equal((await ipFilter.checkIP("203.0.113.7")).allowed, true);
});
