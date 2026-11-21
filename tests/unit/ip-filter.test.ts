import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate DATA_DIR before importing ipFilter: since #6131 the filter lazily
// loads/persists its config to the DB, so an un-isolated run would touch the
// real ~/.omniroute DB (side-effect + WAL-lock flake). Pin a throwaway dir.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-ipfilter-unit-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { resetTestDb } = await import("../helpers/postgres.ts");
const core = await import("../../src/lib/db/core.ts");
const {
  checkIP,
  configureIPFilter,
  tempBanIP,
  removeTempBan,
  addToBlacklist,
  removeFromBlacklist,
  addToWhitelist,
  removeFromWhitelist,
  getIPFilterConfig,
  checkRequestIP,
  resetIPFilter,
} = await import("../../open-sse/services/ipFilter.ts");

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test.beforeEach(async () => {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  resetIPFilter();
});

// ─── Disabled ───────────────────────────────────────────────────────────────

test("disabled: allows all IPs", async () => {
  assert.equal((await checkIP("1.2.3.4")).allowed, true);
});

// ─── Blacklist Mode ─────────────────────────────────────────────────────────

test("blacklist: blocks blacklisted IP", async () => {
  await configureIPFilter({ enabled: true, mode: "blacklist", blacklist: ["1.2.3.4"] });
  assert.equal((await checkIP("1.2.3.4")).allowed, false);
  assert.equal((await checkIP("5.6.7.8")).allowed, true);
});

test("blacklist: CIDR match", async () => {
  await configureIPFilter({ enabled: true, mode: "blacklist", blacklist: ["192.168.1.0/24"] });
  assert.equal((await checkIP("192.168.1.100")).allowed, false);
  assert.equal((await checkIP("192.168.2.1")).allowed, true);
});

test("blacklist: wildcard match", async () => {
  await configureIPFilter({ enabled: true, mode: "blacklist", blacklist: ["10.0.*.*"] });
  assert.equal((await checkIP("10.0.1.1")).allowed, false);
  assert.equal((await checkIP("10.1.0.1")).allowed, true);
});

// ─── Whitelist Mode ─────────────────────────────────────────────────────────

test("whitelist: only allows listed IPs", async () => {
  await configureIPFilter({ enabled: true, mode: "whitelist", whitelist: ["1.2.3.4"] });
  assert.equal((await checkIP("1.2.3.4")).allowed, true);
  assert.equal((await checkIP("5.6.7.8")).allowed, false);
});

test("whitelist: CIDR match", async () => {
  await configureIPFilter({ enabled: true, mode: "whitelist", whitelist: ["10.0.0.0/8"] });
  assert.equal((await checkIP("10.255.255.255")).allowed, true);
  assert.equal((await checkIP("11.0.0.1")).allowed, false);
});

test("whitelist: empty whitelist allows all IPs (admin can still reach dashboard)", async () => {
  await configureIPFilter({ enabled: true, mode: "whitelist", whitelist: [] });
  assert.equal((await checkIP("1.2.3.4")).allowed, true);
  assert.equal((await checkIP("5.6.7.8")).allowed, true);
});

test("whitelist: non-empty whitelist blocks unlisted IPs", async () => {
  await configureIPFilter({ enabled: true, mode: "whitelist", whitelist: ["1.2.3.4"] });
  assert.equal((await checkIP("1.2.3.4")).allowed, true);
  assert.equal((await checkIP("5.6.7.8")).allowed, false);
});

// ─── Whitelist Priority Mode ────────────────────────────────────────────────

test("whitelist-priority: whitelist overrides blacklist", async () => {
  await configureIPFilter({
    enabled: true,
    mode: "whitelist-priority",
    blacklist: ["192.168.1.0/24"],
    whitelist: ["192.168.1.100"],
  });
  assert.equal((await checkIP("192.168.1.100")).allowed, true); // Whitelisted
  assert.equal((await checkIP("192.168.1.50")).allowed, false); // Blacklisted
  assert.equal((await checkIP("10.0.0.1")).allowed, true); // Neither
});

// ─── Temporary Bans ─────────────────────────────────────────────────────────

test("tempBanIP: bans temporarily", async () => {
  await configureIPFilter({ enabled: true, mode: "blacklist" });
  tempBanIP("5.5.5.5", 60000, "abuse");
  assert.equal((await checkIP("5.5.5.5")).allowed, false);
  assert.ok((await checkIP("5.5.5.5")).reason.includes("banned"));
});

test("removeTempBan: removes ban", async () => {
  await configureIPFilter({ enabled: true, mode: "blacklist" });
  tempBanIP("5.5.5.5", 60000, "abuse");
  removeTempBan("5.5.5.5");
  assert.equal((await checkIP("5.5.5.5")).allowed, true);
});

// ─── Dynamic List Management ────────────────────────────────────────────────

test("addToBlacklist/removeFromBlacklist: dynamic updates", async () => {
  await configureIPFilter({ enabled: true, mode: "blacklist" });
  await addToBlacklist("9.9.9.9");
  assert.equal((await checkIP("9.9.9.9")).allowed, false);
  await removeFromBlacklist("9.9.9.9");
  assert.equal((await checkIP("9.9.9.9")).allowed, true);
});

test("addToWhitelist/removeFromWhitelist: dynamic updates", async () => {
  await configureIPFilter({ enabled: true, mode: "whitelist" });
  await addToWhitelist("1.1.1.1");
  await addToWhitelist("2.2.2.2");
  assert.equal((await checkIP("1.1.1.1")).allowed, true);
  await removeFromWhitelist("1.1.1.1");
  assert.equal((await checkIP("1.1.1.1")).allowed, false);
  // #13534: removing the last entry leaves an empty whitelist, which no longer
  // enforces (so an admin who has not populated the list yet is not locked out).
  await removeFromWhitelist("2.2.2.2");
  assert.equal((await checkIP("1.1.1.1")).allowed, true);
});

// ─── IPv6 Normalization ─────────────────────────────────────────────────────

test("normalizes ::ffff: prefix", async () => {
  await configureIPFilter({ enabled: true, mode: "blacklist", blacklist: ["1.2.3.4"] });
  assert.equal((await checkIP("::ffff:1.2.3.4")).allowed, false);
});

// ─── T07: X-Forwarded-For validation ───────────────────────────────────────

test("checkRequestIP: skips invalid XFF entries and uses next valid IP", async () => {
  await configureIPFilter({ enabled: true, mode: "whitelist", whitelist: ["1.2.3.4"] });
  const req = {
    headers: {
      get(name) {
        if (name === "x-forwarded-for") return "unknown, 1.2.3.4";
        return null;
      },
    },
  };
  assert.equal((await checkRequestIP(req)).allowed, true);
});

test("checkRequestIP: all-invalid XFF falls back to x-real-ip", async () => {
  await configureIPFilter({ enabled: true, mode: "whitelist", whitelist: ["9.9.9.9"] });
  const req = {
    headers: {
      get(name) {
        if (name === "x-forwarded-for") return "unknown, -, not_an_ip";
        if (name === "x-real-ip") return "9.9.9.9";
        return null;
      },
    },
  };
  assert.equal((await checkRequestIP(req)).allowed, true);
});

test("checkRequestIP: empty headers fall back to the trusted peer IP, else unknown", async () => {
  await configureIPFilter({ enabled: true, mode: "whitelist", whitelist: ["7.7.7.7"] });
  const req = {
    headers: {
      get() {
        return null;
      },
    },
  };
  assert.equal((await checkRequestIP(req, "7.7.7.7")).allowed, true);
  assert.equal((await checkRequestIP(req)).allowed, false);
});

// ─── Config API ─────────────────────────────────────────────────────────────

test("getIPFilterConfig: returns serializable config", async () => {
  await configureIPFilter({ enabled: true, mode: "whitelist", whitelist: ["1.2.3.4"] });
  const config = await getIPFilterConfig();
  assert.equal(config.enabled, true);
  assert.equal(config.mode, "whitelist");
  assert.ok(Array.isArray(config.whitelist));
  assert.ok(config.whitelist.includes("1.2.3.4"));
});
