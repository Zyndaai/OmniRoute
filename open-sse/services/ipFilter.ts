/**
 * IP Filter Middleware — Phase 6
 *
 * IP-based access control with blacklist, whitelist, priority modes, and temporary bans.
 */

import { isIP } from "node:net";
import { db } from "../../src/lib/db/pg.ts";
import { configJson, getConfigValue } from "../../src/lib/db/configEntries.ts";

// In-memory IP lists
let _config = {
  enabled: false,
  mode: "blacklist",
  blacklist: new Set(),
  whitelist: new Set(),
  tempBans: new Map(),
};

// Persistence (#6131): the config used to live in memory only, so every restart
// (i.e. every OmniRoute update) reset it to Disabled + empty lists. It is now
// persisted to `config_entries` (namespace 'ipFilter', key 'config') and loaded
// on access. tempBans are intentionally NOT persisted — they are ephemeral,
// TTL-swept runtime state.
//
// D2 (#9033): there is no one-shot load gate, so a config persisted by the
// dashboard settings route (a separate module instance, since @omniroute/open-sse
// is bundled per-entry via transpilePackages) propagates to the proxy runtime
// without a restart. Reads are cached for LOAD_TTL_MS so the request path does not
// query per request; a write through this module refreshes the cache at once. A DB
// failure still degrades to the in-memory state, and tempBans remain in-memory-only.
const IP_FILTER_NAMESPACE = "ipFilter";
const IP_FILTER_KEY = "config";
const LOAD_TTL_MS = 1000;
let _loadedAt = 0;
// Bumped when a mutation starts and again when it ends, so a load whose read overlapped a
// mutation never applies its (possibly pre-write) snapshot over the mutation's result.
let _mutationSeq = 0;

type StoredIpFilterConfig = {
  enabled?: boolean;
  mode?: string;
  blacklist?: string[];
  whitelist?: string[];
};

function applyStored(parsed: StoredIpFilterConfig | null | undefined) {
  if (!parsed || typeof parsed !== "object") return;
  _config.enabled = parsed.enabled === true;
  if (typeof parsed.mode === "string") _config.mode = parsed.mode;
  _config.blacklist = new Set(Array.isArray(parsed.blacklist) ? parsed.blacklist : []);
  _config.whitelist = new Set(Array.isArray(parsed.whitelist) ? parsed.whitelist : []);
}

async function ensureLoaded() {
  if (Date.now() - _loadedAt < LOAD_TTL_MS) return;
  const seq = _mutationSeq;
  try {
    const stored = await getConfigValue<StoredIpFilterConfig>(IP_FILTER_NAMESPACE, IP_FILTER_KEY);
    if (seq === _mutationSeq) applyStored(stored);
  } catch {
    // No DB / table yet — keep the in-memory defaults.
  }
  _loadedAt = Date.now();
}

/**
 * Applies `change` to the stored config under a lock (two admins editing the lists at once
 * both land) and persists it. A DB failure never breaks the request path: the change still
 * applies to the in-memory state.
 */
async function mutateConfig(change: () => void) {
  _mutationSeq++;
  try {
    await db().transaction(async (tx) => {
      await tx.execute("SELECT pg_advisory_xact_lock(hashtext('ipFilter:config'))");
      applyStored(
        await getConfigValue<StoredIpFilterConfig>(IP_FILTER_NAMESPACE, IP_FILTER_KEY, tx)
      );
      change();
      await tx.execute(
        `INSERT INTO config_entries (namespace, key, value) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [
          IP_FILTER_NAMESPACE,
          IP_FILTER_KEY,
          configJson({
            enabled: _config.enabled,
            mode: _config.mode,
            blacklist: Array.from(_config.blacklist),
            whitelist: Array.from(_config.whitelist),
          }),
        ]
      );
    });
  } catch {
    // Best-effort persistence. The change is idempotent, so re-applying is safe.
    change();
  }
  _mutationSeq++;
  _loadedAt = Date.now();
}

const _tempBanSweep = setInterval(() => {
  const now = Date.now();
  const bans = _config.tempBans as Map<string, { until: number; reason: string }>;
  for (const [ip, entry] of bans) {
    if (now >= entry.until) bans.delete(ip);
  }
}, 60_000);
if (typeof _tempBanSweep === "object" && "unref" in _tempBanSweep) {
  (_tempBanSweep as { unref?: () => void }).unref?.();
}

/**
 * Configure the IP filter
 */
export async function configureIPFilter(config) {
  await mutateConfig(() => {
    if (config.enabled !== undefined) _config.enabled = config.enabled;
    if (config.mode) _config.mode = config.mode;
    if (config.blacklist) _config.blacklist = new Set(config.blacklist);
    if (config.whitelist) _config.whitelist = new Set(config.whitelist);
  });
}

/**
 * Get current IP filter config (for API)
 */
export async function getIPFilterConfig() {
  await ensureLoaded();
  return {
    enabled: _config.enabled,
    mode: _config.mode,
    blacklist: Array.from(_config.blacklist),
    whitelist: Array.from(_config.whitelist),
    tempBans: Array.from(_config.tempBans.entries()).map(([ip, info]) => ({
      ip,
      until: new Date(info.until).toISOString(),
      reason: info.reason,
      remainingMs: Math.max(0, info.until - Date.now()),
    })),
  };
}

/**
 * Check if an IP is allowed
 * @param {string} ip
 * @returns {{ allowed: boolean, reason?: string }}
 */
export async function checkIP(ip) {
  await ensureLoaded();
  if (!_config.enabled) return { allowed: true };
  if (!ip) return { allowed: true };

  const normalizedIP = normalizeIP(ip);

  // Check temp bans first (highest priority)
  const ban = _config.tempBans.get(normalizedIP);
  if (ban) {
    if (Date.now() < ban.until) {
      return { allowed: false, reason: `Temporarily banned: ${ban.reason}` };
    }
    _config.tempBans.delete(normalizedIP); // Expired
  }

  switch (_config.mode) {
    case "whitelist":
      // Only whitelisted IPs allowed — but if the whitelist is empty the admin
      // has just switched to this mode and has not added IPs yet.  Allow the
      // request through so the admin can still reach the dashboard to populate
      // the list.  Once at least one entry exists, enforcement kicks in.
      if (_config.whitelist.size === 0) {
        return { allowed: true };
      }
      if (!matchesAny(normalizedIP, _config.whitelist)) {
        return { allowed: false, reason: "IP not in whitelist" };
      }
      return { allowed: true };

    case "whitelist-priority":
      // Whitelist overrides blacklist
      if (matchesAny(normalizedIP, _config.whitelist)) {
        return { allowed: true };
      }
      if (matchesAny(normalizedIP, _config.blacklist)) {
        return { allowed: false, reason: "IP blacklisted" };
      }
      return { allowed: true };

    case "blacklist":
    default:
      // Blacklisted IPs blocked
      if (matchesAny(normalizedIP, _config.blacklist)) {
        return { allowed: false, reason: "IP blacklisted" };
      }
      return { allowed: true };
  }
}

/**
 * Temporarily ban an IP
 */
export function tempBanIP(ip, durationMs, reason = "Automated ban") {
  const normalizedIP = normalizeIP(ip);
  _config.tempBans.set(normalizedIP, {
    until: Date.now() + durationMs,
    reason,
  });
}

/**
 * Remove a temporary ban
 */
export function removeTempBan(ip) {
  _config.tempBans.delete(normalizeIP(ip));
}

/**
 * Add IP to blacklist
 */
export async function addToBlacklist(ip) {
  await mutateConfig(() => {
    _config.blacklist.add(normalizeIP(ip));
  });
}

/**
 * Remove IP from blacklist
 */
export async function removeFromBlacklist(ip) {
  await mutateConfig(() => {
    _config.blacklist.delete(normalizeIP(ip));
  });
}

/**
 * Add IP to whitelist
 */
export async function addToWhitelist(ip) {
  await mutateConfig(() => {
    _config.whitelist.add(normalizeIP(ip));
  });
}

/**
 * Remove IP from whitelist
 */
export async function removeFromWhitelist(ip) {
  await mutateConfig(() => {
    _config.whitelist.delete(normalizeIP(ip));
  });
}

/**
 * Express-style middleware factory (also works with a raw Node response)
 */
export function createIPFilterMiddleware() {
  return async (req, res, next) => {
    const ip = extractClientIP(req);
    const { allowed, reason } = await checkIP(ip);
    if (!allowed) {
      const statusCode = 403;
      if (res.status) {
        // Express
        return res.status(statusCode).json({ error: reason || "Access denied" });
      }
      // Raw response
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: reason || "Access denied" }));
    }
    if (next) next();
  };
}

/**
 * Check the IP of a fetch `Request`.
 *
 * D1 (#9033): accepts an optional trustedPeerIp (resolved from the authenticated
 * peer stamp, the only peer address on a `Request`, which has no socket). When
 * provided, it is checked FIRST before falling through to the
 * forwarding headers, so a blacklisted IP on a direct connection (no XFF, no
 * socket) is blocked. When behind a reverse proxy (via-proxy marker set), the
 * caller passes null so the XFF path continues to work.
 */
export async function checkRequestIP(request, trustedPeerIp) {
  const ip =
    pickFirstValidIp(trustedPeerIp || null) ||
    pickFirstValidIp(request.headers?.get?.("cf-connecting-ip")) ||
    pickFirstValidIp(request.headers?.get?.("x-forwarded-for")) ||
    pickFirstValidIp(request.headers?.get?.("x-real-ip")) ||
    "unknown";
  return checkIP(ip);
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

function normalizeIP(ip) {
  if (!ip) return "";
  // Remove IPv6 prefix from IPv4-mapped addresses
  return ip.replace(/^::ffff:/, "").trim();
}

function pickFirstValidIp(rawValue) {
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) return null;
  const candidates = rawValue.split(",");
  for (const candidate of candidates) {
    const normalized = normalizeIP(candidate);
    if (normalized && isIP(normalized) !== 0) {
      return normalized;
    }
  }
  return null;
}

function matchesAny(ip, ipSet) {
  // Direct match
  if (ipSet.has(ip)) return true;

  // CIDR match
  for (const entry of ipSet) {
    if (entry.includes("/") && matchesCIDR(ip, entry)) return true;
    // Wildcard match (e.g., "192.168.*.*")
    if (entry.includes("*") && matchesWildcard(ip, entry)) return true;
  }
  return false;
}

function matchesCIDR(ip, cidr) {
  try {
    const [range, bits] = cidr.split("/");
    const mask = parseInt(bits, 10);
    if (isNaN(mask) || mask < 0 || mask > 32) return false;
    const ipNum = ipToNum(ip);
    const rangeNum = ipToNum(range);
    if (ipNum === null || rangeNum === null) return false;
    const maskBits = (-1 << (32 - mask)) >>> 0;
    return (ipNum & maskBits) === (rangeNum & maskBits);
  } catch {
    return false;
  }
}

function ipToNum(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let num = 0;
  for (const p of parts) {
    const n = parseInt(p, 10);
    if (isNaN(n) || n < 0 || n > 255) return null;
    num = (num << 8) | n;
  }
  return num >>> 0;
}

function matchesWildcard(ip, pattern) {
  const ipParts = ip.split(".");
  const patParts = pattern.split(".");
  if (ipParts.length !== 4 || patParts.length !== 4) return false;
  return ipParts.every((part, i) => patParts[i] === "*" || part === patParts[i]);
}

function extractClientIP(req) {
  const headers = req.headers || {};
  return (
    pickFirstValidIp(headers["cf-connecting-ip"]) ||
    pickFirstValidIp(headers["x-forwarded-for"]) ||
    pickFirstValidIp(headers["x-real-ip"]) ||
    pickFirstValidIp(req.socket?.remoteAddress) ||
    pickFirstValidIp(req.ip) ||
    "unknown"
  );
}

/**
 * Reset config (for testing)
 */
export function resetIPFilter() {
  _loadedAt = 0;
  _config = {
    enabled: false,
    mode: "blacklist",
    blacklist: new Set(),
    whitelist: new Set(),
    tempBans: new Map(),
  };
}
