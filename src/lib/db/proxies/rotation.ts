// Proxy scope pool rotation & alive-pool resolution (#6365).
//
// Extracted from ../proxies.ts (#7046 file-size follow-up): this module holds the
// rotation-strategy bookkeeping (cursor persistence, strategy normalization) and the
// read-only alive-pool resolution used by the registry proxy resolvers. It has no
// dependency back on ../proxies.ts — mutators that also need to bump the registry
// generation counter (addProxyToScopePool, removeProxyFromScopePool,
// setScopeRotationStrategy) stay in ../proxies.ts and import the pure helpers here.
import { randomInt } from "crypto";
import { db, type DbExecutor } from "@/lib/db/pg";
import { pickByLatency } from "../proxyLatency";
import {
  hasProxyRefusals,
  isProxyAvoided,
  proxyEgressKey,
} from "@omniroute/open-sse/utils/proxyRefusalMemory.ts";
import { isEgressBucketedLockScope } from "@omniroute/open-sse/config/providerErrorRules.ts";
import { maybeEmitPoolExhausted } from "@/lib/proxyEvents/proxyTransitionBridge";
import {
  isOperatorEgressEnabled,
  isProxySkipRecentlyFailedEnabled,
  isProxyPoolSharedEgressOrderEnabled,
} from "@/shared/utils/featureFlags";
import { getCachedProxyHealth } from "@/lib/proxyHealth";
import { getRecentEgressIpForProxy, getRecentEgressIpsForProxy } from "../proxyLogs";
import { egressKeyForAddresses, normalizeEgressAddress } from "@/shared/network/egressAddress";
import { readOperatorEgressForMember } from "../proxyOperatorEgress";
import { decryptProxyPassword } from "./sanitize";
import type { JsonRecord, ProxyScope, ProxyRotationStrategy } from "./types";
import { PROXY_ROTATION_STRATEGIES, DEFAULT_PROXY_ROTATION_STRATEGY } from "./types";
import {
  mapAssignmentRow,
  toRegistryProxyResolution,
  normalizeScope,
  normalizeAssignmentScopeId,
} from "./mappers";

// The cursor column is an int4; wrapping keeps a hot pool from overflowing it after 2^31 picks.
// The wrap only skews fairness once per cycle.
const CURSOR_WRAP = 1_000_000_000;

// Rotation state keys off the SAME normalized scope_id as assignments so a global
// pool ('__global__') and a per-scope pool share one deterministic cursor row.
export function normalizeRotationScopeId(scope: ProxyScope, scopeId?: string | null): string {
  return normalizeAssignmentScopeId(scope, scopeId) ?? "";
}

/** `executor` is `db()` or the `tx` of a surrounding transaction. */
export async function clearRotationState(
  executor: DbExecutor,
  scope: string,
  normalizedScopeId: string | null
): Promise<void> {
  await executor.execute("DELETE FROM proxy_scope_rotation WHERE scope = $1 AND scope_id = $2", [
    scope,
    normalizedScopeId ?? "",
  ]);
}

export async function resetRotationCursor(
  executor: DbExecutor,
  scope: string,
  normalizedScopeId: string | null
): Promise<void> {
  await executor.execute(
    "UPDATE proxy_scope_rotation SET cursor = 0, rotated_at = NULL, updated_at = now() WHERE scope = $1 AND scope_id = $2",
    [scope, normalizedScopeId ?? ""]
  );
}

export function normalizeRotationStrategy(strategy: unknown): ProxyRotationStrategy {
  return PROXY_ROTATION_STRATEGIES.includes(strategy as ProxyRotationStrategy)
    ? (strategy as ProxyRotationStrategy)
    : DEFAULT_PROXY_ROTATION_STRATEGY;
}

/**
 * List a scope's pool members in rotation order (position ASC). Includes every
 * assigned proxy regardless of alive status — callers that only want serviceable
 * members should filter by proxy status themselves.
 */
export async function getScopeProxyPool(scope: string, scopeId?: string | null) {
  const normalizedScope = normalizeScope(scope);
  const normalizedScopeId = normalizeAssignmentScopeId(normalizedScope, scopeId);
  const rows = await db().query(
    "SELECT id, proxy_id, scope, scope_id, position, created_at, updated_at FROM proxy_assignments WHERE scope = $1 AND scope_id = $2 ORDER BY position ASC, created_at ASC, id ASC",
    [normalizedScope, normalizedScopeId]
  );
  return rows.map(mapAssignmentRow);
}

/** Read a scope's rotation strategy (#6365). Defaults to `round-robin`. */
export async function getScopeRotationStrategy(
  scope: string,
  scopeId?: string | null
): Promise<ProxyRotationStrategy> {
  const normalizedScope = normalizeScope(scope);
  const rotationScopeId = normalizeRotationScopeId(normalizedScope, scopeId);
  const row = await db().queryOne<{ strategy?: string }>(
    "SELECT strategy FROM proxy_scope_rotation WHERE scope = $1 AND scope_id = $2",
    [normalizedScope, rotationScopeId]
  );
  return normalizeRotationStrategy(row?.strategy);
}

// Read the rotation row for a scope, creating a default one lazily so the
// round-robin cursor has somewhere to live. Best-effort: any write failure leaves
// the caller on the default strategy with an ephemeral cursor.
async function getOrCreateRotationRow(
  executor: DbExecutor,
  normalizedScope: string,
  rotationScopeId: string
): Promise<{
  strategy: ProxyRotationStrategy;
  cursor: number;
  stickyWindowMinutes: number;
  rotatedAt: string | null;
}> {
  const row = await executor.queryOne<{
    strategy?: string;
    cursor?: number;
    sticky_window_minutes?: number;
    rotated_at?: string | null;
  }>(
    "SELECT strategy, cursor, sticky_window_minutes, rotated_at FROM proxy_scope_rotation WHERE scope = $1 AND scope_id = $2",
    [normalizedScope, rotationScopeId]
  );

  if (row) {
    return {
      strategy: normalizeRotationStrategy(row.strategy),
      cursor: Number(row.cursor) || 0,
      stickyWindowMinutes: Number(row.sticky_window_minutes) || 30,
      rotatedAt: typeof row.rotated_at === "string" ? row.rotated_at : null,
    };
  }

  await executor.execute(
    `INSERT INTO proxy_scope_rotation (scope, scope_id, strategy, cursor, updated_at)
     VALUES ($1, $2, $3, 0, now())
     ON CONFLICT (scope, scope_id) DO NOTHING`,
    [normalizedScope, rotationScopeId, DEFAULT_PROXY_ROTATION_STRATEGY]
  );
  return {
    strategy: DEFAULT_PROXY_ROTATION_STRATEGY,
    cursor: 0,
    stickyWindowMinutes: 30,
    rotatedAt: null,
  };
}

// Indexes of the members not currently set aside by the proxy refusal memory, or null to
// keep the plain behavior: nothing set aside, every member set aside (an all-failed pool
// keeps today's selection and its #6246 fail-closed contract), or PROXY_SKIP_RECENTLY_FAILED
// off. The flag is read last, only when skipping would actually change the pick.
// With an egress-bucketed provider scope, a refusal on one entry also sets aside
// the entries sharing one of its observed egress addresses for that scope; other
// scopes and a null provider keep the entry-level behavior. The scope gate is
// isEgressBucketedLockScope (case-insensitive, the same gate as
// buildHotEgressPredicate). Model and endpoint stay reserved and are never compared.
async function eligibleMemberIndexes(
  candidates: unknown[],
  provider?: string | null,
  nowMs: number = Date.now()
): Promise<number[] | null> {
  if (!hasProxyRefusals()) return null;
  const addressScope = await addressScopeFor(provider, candidates, nowMs);
  const eligible: number[] = [];
  candidates.forEach((row, index) => {
    if (!isProxyAvoided(proxyEgressKey(row), nowMs) && !addressScope.isShared(row))
      eligible.push(index);
  });
  if (eligible.length === 0 || eligible.length === candidates.length) return null;
  return isProxySkipRecentlyFailedEnabled() ? eligible : null;
}

// Observed egress keys (an exact address, or the range an exit rotates inside) seeded
// only from members the refusal memory already sets aside; matches
// buildHotEgressPredicate's seed discipline. Only scopes in the egress-bucketed lock
// set expand: a refusal for one bucketed scope never sets aside members picked for
// another scope.
async function addressScopeFor(
  provider: string | null | undefined,
  candidates: unknown[],
  nowMs: number
): Promise<{
  isShared: (row: unknown) => boolean;
  isAvoidedKey: (key: string | null) => boolean;
}> {
  const none = {
    isShared: () => false,
    isAvoidedKey: (key: string | null) => isProxyAvoided(key, nowMs),
  };
  if (provider == null) return none;
  if (!isEgressBucketedLockScope(provider)) return none;
  // The egress reads are async, so each candidate's keys are read once up front
  // and the predicates below stay synchronous.
  const memberKeys = new Map<unknown, Set<string>>();
  const hot = new Set<string>();
  for (const row of candidates) {
    if (!isProxyAvoided(proxyEgressKey(row), nowMs)) continue;
    const keys = (await readEgressKeysForMember(row, nowMs)).keys;
    memberKeys.set(row, keys);
    for (const key of keys) hot.add(key);
  }
  if (hot.size === 0) return none;
  for (const row of candidates) {
    if (!memberKeys.has(row)) memberKeys.set(row, (await readEgressKeysForMember(row, nowMs)).keys);
  }
  const byKey = new Map<string, unknown>();
  for (const row of candidates) {
    const key = proxyEgressKey(row);
    if (key !== null) byKey.set(key, row);
  }
  const sharesHot = (row: unknown): boolean => {
    for (const key of memberKeys.get(row) ?? []) {
      if (hot.has(key)) return true;
    }
    return false;
  };
  return {
    isShared: sharesHot,
    isAvoidedKey: (key: string | null) => {
      if (isProxyAvoided(key, nowMs)) return true;
      if (key === null) return false;
      const row = byKey.get(key);
      if (row === undefined) return false;
      return sharesHot(row);
    },
  };
}

// True once the sticky window elapsed (or never started): the held member is due
// for rotation. Shared by the pre-rank bypass (held member served untouched) and
// the sticky branch below (advance on expiry) — same `state`, no extra DB read.
function isStickyExpired(state: {
  stickyWindowMinutes: number;
  rotatedAt: string | null;
}): boolean {
  const lastRotated = state.rotatedAt ? Date.parse(state.rotatedAt) : NaN;
  return (
    !Number.isFinite(lastRotated) || Date.now() - lastRotated >= state.stickyWindowMinutes * 60_000
  );
}

// First eligible index at or after `start`, going round the pool.
function firstEligibleFrom(start: number, eligible: number[], size: number): number {
  for (let step = 0; step < size; step++) {
    const index = (start + step) % size;
    if (eligible.includes(index)) return index;
  }
  return start;
}

/** Health signals read from short-lived process memory, injectable for tests. */
export interface PoolRankSignals {
  isAvoided: (key: string | null) => boolean;
  probeHealth: (url: string) => boolean | null;
  sharesHotEgress?: (candidate: unknown) => boolean;
}

const DEFAULT_POOL_RANK_SIGNALS: PoolRankSignals = {
  isAvoided: isProxyAvoided,
  probeHealth: getCachedProxyHealth,
};

// Relay entries carry the relay URL in `host` and no dispatcher: not rankable.
const RELAY_TYPES = new Set(["vercel", "deno", "cloudflare"]);
// Same scheme defaults as proxyConfigToUrl() so the rebuilt URL hits the probe cache key.
const DEFAULT_PORTS: Record<string, string> = { http: "8080", https: "443", socks5: "1080" };

function isRankableProxyType(type: string): boolean {
  return !RELAY_TYPES.has(type) && type in DEFAULT_PORTS;
}

function probePortForType(record: Record<string, unknown>, type: string): string {
  const parsed = Number(record.port);
  if (record.port && Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
    return String(parsed);
  }
  return DEFAULT_PORTS[type];
}

function probeAuthPart(record: Record<string, unknown>): string {
  const username = typeof record.username === "string" ? record.username : "";
  const password = typeof record.password === "string" ? record.password : "";
  if (!username && !password) return "";
  return `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`;
}

function probeFamilyMarker(record: Record<string, unknown>): string {
  const family = typeof record.family === "string" ? record.family : "";
  return family === "ipv4" || family === "ipv6" ? `?family=${family}` : "";
}

function bracketIpv6Host(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

// Rebuild the probe URL for a pool row the way the dispatcher builds it
// (`proxyConfigToUrl`, read-only replica): scheme + encoded auth + host + port,
// with the `?family=` marker when set. Null when the row cannot egress.
function candidateProbeUrl(row: unknown): string | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  const host = typeof record.host === "string" ? record.host : "";
  if (!host) return null;
  const type = String(record.type || "http").toLowerCase();
  if (!isRankableProxyType(type)) return null;
  const port = probePortForType(record, type);
  const auth = probeAuthPart(record);
  const marker = probeFamilyMarker(record);
  return `${type}://${auth}${bracketIpv6Host(host)}:${port}${marker}`;
}

/**
 * Normalize an observed egress address for pool ranking: a whole IPv4 address
 * (`203.0.113.7`), an IPv4-mapped IPv6 form demapped to IPv4
 * (`::ffff:203.0.113.7`), or an IPv6 /64 prefix (`v6:2001:db8:1:0`) — members
 * behind one shared /64 consume one quota. Anything else (zone ids
 * `fe80::1%eth0`, unparseable input) gives null so the caller falls back to
 * today's order instead of guessing.
 *
 * Thin alias over the shared normalizer (same verdicts: `ipVersion` matches
 * `node:net#isIP` per #11122) so both this module and the operator-egress
 * store normalize identically without a server-only import cycle.
 */
export function normalizeEgressAddressForRanking(ip: unknown): string | null {
  return normalizeEgressAddress(ip);
}

// Short-lived cache of the last observed egress address per pool entry point
// (same 30 s / 200-entry regime as the pool observation panel): keeps repeated
// picks from re-reading the journal row by row.
const HOT_EGRESS_CACHE_TTL_MS = 30_000;
const HOT_EGRESS_CACHE_MAX_ENTRIES = 200;

const hotEgressCache = new Map<string, { at: number; value: MemberEgressObservation }>();

function readHotEgressCache(
  key: string,
  nowMs: number
): { hit: boolean; value: MemberEgressObservation | null } {
  const hit = hotEgressCache.get(key);
  if (!hit || nowMs - hit.at >= HOT_EGRESS_CACHE_TTL_MS) return { hit: false, value: null };
  return { hit: true, value: hit.value };
}

function writeHotEgressCache(key: string, value: MemberEgressObservation, nowMs: number): void {
  if (!hotEgressCache.has(key) && hotEgressCache.size >= HOT_EGRESS_CACHE_MAX_ENTRIES) {
    const oldest = hotEgressCache.keys().next().value;
    if (oldest !== undefined) hotEgressCache.delete(oldest);
  }
  hotEgressCache.set(key, { at: nowMs, value });
}

/** Test-only: forget the cached egress observations. */
export function __resetHotEgressCacheForTesting(): void {
  hotEgressCache.clear();
}

// Key a (host, port) couple exactly the way the journal reader does: trimmed,
// unbracketed, lower-cased host plus the validated port. Anything unusable maps
// to null so the reader below falls back to today's behavior.
function hotEgressCacheKey(row: unknown): string | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  const host = typeof record.host === "string" ? record.host.trim() : "";
  if (!host) return null;
  const unbracketed =
    host.startsWith("[") && host.endsWith("]") && host.length > 2 ? host.slice(1, -1).trim() : host;
  if (!unbracketed) return null;
  const port = Number(record.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `${unbracketed.toLowerCase()}:${port}`;
}

// Observation window for the shared-egress ranking signal: an entry that
// showed several distinct egress addresses within the window is read under
// the key those addresses share (one address, or the range they stay inside).
const EGRESS_RANKING_WINDOW_MS = 30 * 60_000;

// Read ceiling for the ranking signal: the journal reader returns at most this
// many distinct addresses per member and the sample is not ordered, so a
// window holding more addresses than that cannot be shown to stay inside one
// range.
const EGRESS_RANKING_ADDRESS_LIMIT = 10;

/**
 * What the journal showed for one pool member inside the ranking window.
 * Read-only: the observation is shared by reference through the cache, so the
 * whole observation is frozen — a consumer must never mutate it.
 */
type MemberEgressObservation = {
  /** Distinct normalized addresses observed in the window (frozen). */
  readonly addresses: readonly string[];
  /** The key the member is ranked under: exact address, range key, or null. */
  readonly key: string | null;
};

const EMPTY_EGRESS_OBSERVATION: MemberEgressObservation = Object.freeze({
  addresses: Object.freeze([]),
  key: null,
});

/**
 * What the journal showed for one pool member inside the ranking window: the
 * distinct normalized addresses it was seen on, and the key it is ranked
 * under. Best-effort by design: a cold probe cache yields no observation and
 * the caller keeps today's order.
 */
async function readMemberEgressObservation(
  row: unknown,
  nowMs: number
): Promise<MemberEgressObservation> {
  const record = row as Record<string, unknown>;
  const host = typeof record.host === "string" ? record.host : "";
  const port = Number(record.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return EMPTY_EGRESS_OBSERVATION;
  }
  const key = hotEgressCacheKey(row);
  if (key === null) return EMPTY_EGRESS_OBSERVATION;
  const cached = readHotEgressCache(key, nowMs);
  if (cached.hit && cached.value !== null) return cached.value;
  let observation: MemberEgressObservation = EMPTY_EGRESS_OBSERVATION;
  try {
    const sinceIso = new Date(nowMs - EGRESS_RANKING_WINDOW_MS).toISOString();
    const observed = await getRecentEgressIpsForProxy(
      host,
      port,
      sinceIso,
      EGRESS_RANKING_ADDRESS_LIMIT
    );
    const distinct = new Set<string>();
    for (const ip of observed) {
      const normalized = normalizeEgressAddressForRanking(ip);
      if (normalized !== null) distinct.add(normalized);
    }
    observation = Object.freeze({
      // Frozen: the cache shares the observation by reference, a consumer that
      // mutated the array would corrupt it for every other reader.
      addresses: Object.freeze([...distinct]),
      // The query is cut at the read ceiling (DISTINCT … LIMIT, no ORDER BY):
      // when it returned as many rows as the ceiling, the window may hold
      // more addresses than we read, so the member cannot be shown to stay
      // inside one range — it reads unknown. The count is the number of rows
      // the query returned, not the number of normalized keys: one IPv6 /64
      // key stands for several rows.
      key: egressKeyForAddresses(distinct, {
        truncated: observed.length >= EGRESS_RANKING_ADDRESS_LIMIT,
      }),
    });
  } catch {
    observation = EMPTY_EGRESS_OBSERVATION;
  }
  writeHotEgressCache(key, observation, nowMs);
  return observation;
}

/** Egress keys of one pool member: the exact addresses observed plus, for an
 *  exit rotating inside one range, that range's key. `freshest` is the most
 *  recent observation across both sources. */
export type EgressKeySet = {
  keys: Set<string>;
  freshest: { address: string; at: string } | null;
};

/**
 * Every observed egress key for a pool entry point. Flag off: the journal
 * single address or empty, with zero operator DB read — byte-identical to the
 * base behavior. Flag on: the union of the fresh operator rows (direct read,
 * never cached) and the journal key, which is the single observed address or,
 * when the journal window stays inside one range, that range's key; a journal
 * window crossing two ranges never contributes. `freshest` is the most recent
 * observation across both sources — a 20 h operator row loses to a 2 min
 * probe, and wins when the probe is the older one.
 */
export async function readEgressKeysForMember(
  row: unknown,
  nowMs: number = Date.now()
): Promise<EgressKeySet> {
  const observation = await readMemberEgressObservation(row, nowMs);
  // The journal's freshest observation stays an exact address: it is what the
  // observation screen shows. A member rotating inside one range has no
  // single address, so it has no journal freshest (as before).
  const single = observation.addresses.length === 1 ? observation.addresses[0] : null;
  const journalFreshest =
    single !== null ? { address: single, at: await journalFreshestAt(row, nowMs) } : null;
  if (!isOperatorEgressEnabled()) {
    return {
      keys: observation.key !== null ? new Set([observation.key]) : new Set(),
      freshest: journalFreshest,
    };
  }
  const record = row as Record<string, unknown>;
  const host = typeof record.host === "string" ? record.host : "";
  const port = Number(record.port);
  const operator = await readOperatorEgressForMemberSafe(host, port, nowMs);
  const keys = new Set<string>(operator.addresses);
  if (observation.key !== null) keys.add(observation.key);
  let freshest = operator.freshest;
  if (
    journalFreshest !== null &&
    (freshest === null || Date.parse(journalFreshest.at) > Date.parse(freshest.at))
  ) {
    freshest = journalFreshest;
  }
  return { keys, freshest };
}

async function journalFreshestAt(row: unknown, nowMs: number): Promise<string> {
  try {
    const record = row as Record<string, unknown>;
    const host = typeof record.host === "string" ? record.host : "";
    const port = Number(record.port);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      return new Date(nowMs).toISOString();
    }
    const recent = await getRecentEgressIpForProxy(host, port);
    if (recent?.at) return recent.at;
  } catch {
    // Best-effort: fall through to nowMs.
  }
  return new Date(nowMs).toISOString();
}

async function readOperatorEgressForMemberSafe(
  host: string,
  port: number,
  nowMs: number
): Promise<{ addresses: Set<string>; freshest: { address: string; at: string } | null }> {
  try {
    return await readOperatorEgressForMember(host, port, nowMs);
  } catch {
    return { addresses: new Set(), freshest: null };
  }
}

/**
 * Predicate over pool candidates sharing a recently refused egress address,
 * for a provider whose quota is bucketed by egress address. Seeded only from
 * members the refusal memory currently sets aside (a refused member's observed
 * address is the hot one); an empty hot set, a provider outside the list, or
 * any read failure yields a predicate that is false for every candidate, so
 * the pool keeps today's order (order only, never exclude).
 */
export async function buildHotEgressPredicate(
  provider: string | null | undefined,
  candidates: unknown[],
  signals?: Partial<PoolRankSignals>,
  nowMs: number = Date.now()
): Promise<(candidate: unknown) => boolean> {
  const none = () => false;
  if (!isProxySkipRecentlyFailedEnabled()) return none;
  if (!isProxyPoolSharedEgressOrderEnabled()) return none;
  if (!isEgressBucketedLockScope(provider)) return none;
  if (!hasProxyRefusals()) return none;
  const isAvoided = signals?.isAvoided ?? DEFAULT_POOL_RANK_SIGNALS.isAvoided;
  // The egress reads are async: each candidate is read once here (the predicate
  // is then a lookup over the candidates passed in).
  const memberKeys = new Map<unknown, Set<string>>();
  const hot = new Set<string>();
  for (const row of candidates) {
    if (!isAvoided(proxyEgressKey(row))) continue;
    // Avoided members seed from the journal AND the fresh operator rows:
    // either source can name the refused key. The journal contributes when
    // its window stays inside one range (one address, or one range key).
    const keys = (await readEgressKeysForMember(row, nowMs)).keys;
    memberKeys.set(row, keys);
    for (const key of keys) hot.add(key);
  }
  if (hot.size === 0) return none;
  for (const row of candidates) {
    if (!memberKeys.has(row)) memberKeys.set(row, (await readEgressKeysForMember(row, nowMs)).keys);
  }
  return (candidate: unknown) => {
    for (const key of memberKeys.get(candidate) ?? []) {
      if (hot.has(key)) return true;
    }
    return false;
  };
}

/**
 * Order pool candidates by crossed short-memory health signals without removing
 * anyone: a member just set aside ranks last, then a member sharing a recently
 * refused egress address (per-address-quota providers only), then a member
 * whose last cached probe verdict was negative. Unknown (no signal,
 * unreconstructible URL) keeps the current position order. Stable: health ties
 * keep their relative order, so an all-clear or all-set-aside pool returns its
 * input order unchanged.
 */
export function rankPoolCandidates<T>(candidates: T[], signals?: Partial<PoolRankSignals>): T[] {
  if (candidates.length < 2) return [...candidates];
  const { isAvoided, probeHealth, sharesHotEgress } = {
    ...DEFAULT_POOL_RANK_SIGNALS,
    isAvoided: signals?.isAvoided ?? DEFAULT_POOL_RANK_SIGNALS.isAvoided,
    probeHealth: signals?.probeHealth ?? DEFAULT_POOL_RANK_SIGNALS.probeHealth,
    sharesHotEgress: signals?.sharesHotEgress ?? DEFAULT_POOL_RANK_SIGNALS.sharesHotEgress,
  };
  const scored = candidates.map((candidate, index) => {
    if (isAvoided(proxyEgressKey(candidate))) return { candidate, index, score: 3 };
    if (sharesHotEgress?.(candidate) === true) return { candidate, index, score: 2 };
    const url = candidateProbeUrl(candidate);
    if (url !== null && probeHealth(url) === false) return { candidate, index, score: 1 };
    return { candidate, index, score: 0 };
  });
  if (scored.every((entry) => entry.score === scored[0].score)) return [...candidates];
  return scored
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.candidate);
}

type RotationPickState = {
  strategy: ProxyRotationStrategy;
  cursor: number;
  stickyWindowMinutes: number;
  rotatedAt: string | null;
};

// A held sticky member is served untouched (replaced for this pick only when set
// aside): no extra write, no ranking. Returns undefined when not held.
async function pickHeldStickyMember<T>(
  state: RotationPickState,
  candidates: T[],
  provider?: string | null,
  nowMs: number = Date.now()
): Promise<T | undefined> {
  if (state.strategy !== "sticky" || isStickyExpired(state)) return undefined;
  const idx = ((state.cursor % candidates.length) + candidates.length) % candidates.length;
  const eligible = await eligibleMemberIndexes(candidates, provider, nowMs);
  return candidates[eligible ? firstEligibleFrom(idx, eligible, candidates.length) : idx];
}

// Order by crossed short-memory health signals (PROXY_SKIP_RECENTLY_FAILED, default on):
// stops re-serving at the head a proxy that just failed, without removing anyone.
// For providers whose quota is bucketed by egress address, a member sharing the
// refused member's observed address ranks just below healthy members (order only,
// never excluded).
// NOTE: ranking changes which member the persisted cursor lands on. After a
// set-aside, the next pick serves the healthiest member at-or-after the cursor
// (not the cursor member itself when it was set aside) — the cursor then
// advances past the member served, preserving rotation without re-serving the
// failed head first.
async function rankCandidatesForPick<T>(candidates: T[], provider?: string | null): Promise<T[]> {
  if (!isProxySkipRecentlyFailedEnabled()) return [...candidates];
  if (provider == null) return rankPoolCandidates(candidates);
  return rankPoolCandidates(candidates, {
    sharesHotEgress: await buildHotEgressPredicate(provider, candidates),
  });
}

function pickRandomCandidate<T>(ranked: T[], eligible: number[] | null): T {
  // crypto.randomInt (unbiased, uniform in [0, length)) instead of Math.random —
  // CodeQL js/insecure-randomness flags Math.random flowing into the selected proxy's
  // credentials (a "security context"). Load-balancing selection is not a secret, but
  // crypto.randomInt silences the alert at the source and is unbiased (#6365 follow-up).
  if (eligible) return ranked[eligible[randomInt(eligible.length)]];
  return ranked[randomInt(ranked.length)];
}

async function pickLatencyCandidate<T>(
  executor: DbExecutor,
  ranked: T[],
  eligible: number[] | null
): Promise<T> {
  return pickByLatency(executor, eligible ? eligible.map((index) => ranked[index]) : ranked);
}

async function pickStickyCandidate<T>(
  executor: DbExecutor,
  state: RotationPickState,
  normalizedScope: string,
  rotationScopeId: string,
  ranked: T[],
  eligible: number[] | null
): Promise<T> {
  const expired = isStickyExpired(state);
  let cursor = state.cursor;
  if (expired) {
    // Atomic advance: of several concurrent pickers that all saw the window
    // elapsed, only one moves the cursor (the others re-read the new value).
    const cutoff = new Date(Date.now() - state.stickyWindowMinutes * 60_000).toISOString();
    const advanced = await executor.queryOne<{ cursor: number }>(
      `UPDATE proxy_scope_rotation
          SET cursor = (cursor + 1) % ${CURSOR_WRAP}, rotated_at = now(), updated_at = now()
        WHERE scope = $1 AND scope_id = $2 AND (rotated_at IS NULL OR rotated_at <= $3)
        RETURNING cursor`,
      [normalizedScope, rotationScopeId, cutoff]
    );
    if (advanced) {
      cursor = Number(advanced.cursor);
    } else {
      const current = await executor.queryOne<{ cursor: number }>(
        "SELECT cursor FROM proxy_scope_rotation WHERE scope = $1 AND scope_id = $2",
        [normalizedScope, rotationScopeId]
      );
      cursor = current ? Number(current.cursor) : state.cursor + 1;
    }
  }
  const idx = ((cursor % ranked.length) + ranked.length) % ranked.length;
  // A held member set aside is replaced for this pick only: no extra write.
  return ranked[eligible ? firstEligibleFrom(idx, eligible, ranked.length) : idx];
}

// round-robin (default): pick at the current cursor, then advance it monotonically,
// past any member skipped so the next pick starts after the one actually served.
async function pickRoundRobinCandidate<T>(
  executor: DbExecutor,
  state: RotationPickState,
  normalizedScope: string,
  rotationScopeId: string,
  ranked: T[],
  eligible: number[] | null
): Promise<T> {
  // Atomic fetch-and-add: the UPDATE hands every concurrent picker its own
  // cursor value, so two requests never read the same position. The row is
  // advanced by one here and by the skipped members below.
  const claimed = await executor.queryOne<{ prev: number }>(
    `UPDATE proxy_scope_rotation SET cursor = (cursor + 1) % ${CURSOR_WRAP}, updated_at = now()
      WHERE scope = $1 AND scope_id = $2
      RETURNING (cursor + ${CURSOR_WRAP - 1}) % ${CURSOR_WRAP} AS prev`,
    [normalizedScope, rotationScopeId]
  );
  const base = claimed ? Number(claimed.prev) : state.cursor;
  const idx = ((base % ranked.length) + ranked.length) % ranked.length;
  const served = eligible ? firstEligibleFrom(idx, eligible, ranked.length) : idx;
  const skipped = (served - idx + ranked.length) % ranked.length;
  if (claimed && skipped > 0) {
    await executor.execute(
      `UPDATE proxy_scope_rotation SET cursor = (cursor + $3) % ${CURSOR_WRAP} WHERE scope = $1 AND scope_id = $2`,
      [normalizedScope, rotationScopeId, skipped]
    );
  }
  return ranked[served];
}

/**
 * Pick one member from an already-alive candidate list according to the scope's
 * rotation strategy. Assumes `candidates` is non-empty and ordered by position.
 * Round-robin uses (and persists) a monotonic cursor; random uses crypto.randomInt;
 * sticky holds the current member until its window elapses, then advances.
 * Members that just failed (see proxyRefusalMemory) are skipped while another member is
 * eligible; the cursor then advances past the member actually served.
 */
async function pickFromCandidates<T>(
  executor: DbExecutor,
  normalizedScope: string,
  rotationScopeId: string,
  candidates: T[],
  provider?: string | null
): Promise<T> {
  // Pool-exhausted check first: a single-member pool set aside is exhausted
  // too, and this runs before the length-1 early return below. Flag-gated
  // inside (zero cost when off), rebound window shared with the bridge. The
  // check shares the selection predicate: a pool whose every address is set
  // aside emits like an all-set-aside legacy pool.
  const nowMs = Date.now();
  const addressScope = await addressScopeFor(provider, candidates, nowMs);
  maybeEmitPoolExhausted(
    normalizedScope,
    candidates,
    (row) => proxyEgressKey(row),
    (key) => addressScope.isAvoidedKey(key)
  );
  if (candidates.length === 1) return candidates[0];

  const state = await getOrCreateRotationRow(executor, normalizedScope, rotationScopeId);

  const held = await pickHeldStickyMember(state, candidates, provider, nowMs);
  if (held !== undefined) return held;

  // Sticky past its window and every other strategy rank normally; a held sticky
  // member returns above, untouched. The eligible-skip below still applies on the
  // ranked list, so a set-aside member stays skipped while another is eligible and
  // the cursor advances past the member actually served.
  const ranked = await rankCandidatesForPick(candidates, provider);
  const eligible = await eligibleMemberIndexes(ranked, provider, nowMs);

  if (state.strategy === "random") return pickRandomCandidate(ranked, eligible);
  if (state.strategy === "latency") return pickLatencyCandidate(executor, ranked, eligible);
  if (state.strategy === "sticky") {
    return pickStickyCandidate(executor, state, normalizedScope, rotationScopeId, ranked, eligible);
  }
  return pickRoundRobinCandidate(
    executor,
    state,
    normalizedScope,
    rotationScopeId,
    ranked,
    eligible
  );
}

// Fetch the alive, position-ordered candidate rows for a (scope, scope_id) pool.
// Pass the query-level scope_id (connection id / provider / '__global__' / combo
// id) — global callers pass null to match the historical "any global row"
// behavior. A null filter with `matchAnyScopeId` false matches nothing
// (scope_id is NOT NULL).
async function fetchAlivePoolRows(
  executor: DbExecutor,
  scope: string,
  scopeIdFilter: string | null,
  matchAnyScopeId: boolean
): Promise<JsonRecord[]> {
  const baseSelect =
    'SELECT p.id, p.name, p.type, p.host, p.port, p.username, p.password, p.notes, p.family, a.position AS "__pos", a.id AS "__aid" ' +
    "FROM proxy_assignments a JOIN proxy_registry p ON p.id = a.proxy_id WHERE a.scope = $1 ";
  const order = " ORDER BY a.position ASC, a.id ASC";
  const rows = matchAnyScopeId
    ? await executor.query<JsonRecord>(`${baseSelect}AND ${PROXY_ALIVE_PREDICATE}${order}`, [scope])
    : await executor.query<JsonRecord>(
        `${baseSelect}AND a.scope_id = $2 AND ${PROXY_ALIVE_PREDICATE}${order}`,
        [scope, scopeIdFilter]
      );
  return rows.map((row) => ({ ...row, password: decryptProxyPassword(row.password) }));
}

// Read-only view of a scope pool's alive candidate rows (same joined source as the
// selection path above): registry fields joined to assignments, alive-predicate
// applied, position order. Lets a read-only status screen rank the same rows the
// selector ranks, without embedding SQL in a route (Hard Rule #5).
export async function getScopePoolEgressRows(
  scope: string,
  scopeIdFilter: string | null
): Promise<JsonRecord[]> {
  return fetchAlivePoolRows(db(), scope, scopeIdFilter, scopeIdFilter === null);
}

// A proxy is "alive" for resolution unless it has been explicitly marked dead
// (by an operator or a health check). Conservative: active/null/unknown stay
// usable so a working proxy is never stranded; only known-dead states are
// excluded so a dead proxy stops being handed out (every request would
// otherwise pay the timeout or leak out the host IP).
export const PROXY_ALIVE_PREDICATE =
  "(p.status IS NULL OR LOWER(p.status) NOT IN ('inactive','error','disabled','dead','down'))";

// Resolve one scope's alive pool to a single proxy via its rotation strategy.
// Returns the standard registry resolution shape, or null when the pool is empty
// or every member is dead (preserving the #6246 fail-closed contract — a dead
// pool never falls through to direct egress; the caller's guard blocks it).
async function resolveScopePoolInternal(
  executor: DbExecutor,
  scope: ProxyScope,
  levelId: string | null,
  options: { rotationScopeId: string; matchAnyScopeId?: boolean; scopeIdFilter?: string | null }
): Promise<ReturnType<typeof toRegistryProxyResolution> | null> {
  const rows = await fetchAlivePoolRows(
    executor,
    scope,
    options.scopeIdFilter ?? null,
    options.matchAnyScopeId === true
  );
  if (rows.length === 0) return null;
  const picked = await pickFromCandidates(
    executor,
    scope,
    options.rotationScopeId,
    rows,
    await resolvePoolProvider(executor, scope, levelId, options)
  );
  return toRegistryProxyResolution(picked, scope, levelId);
}

// Which provider a pool pick serves, for the egress-aware ranking signal only.
// Provider scope already knows it; an account pool resolves its connection's
// provider with one bounded row (only reached when the signal guards already
// passed); combo and global pools serve several providers, so they abstain.
async function resolvePoolProvider(
  executor: DbExecutor,
  scope: ProxyScope,
  levelId: string | null,
  options: { rotationScopeId: string; matchAnyScopeId?: boolean; scopeIdFilter?: string | null }
): Promise<string | null> {
  if (scope === "provider") return levelId;
  if (scope !== "account" || !options.scopeIdFilter) return null;
  if (
    !isProxySkipRecentlyFailedEnabled() ||
    !isProxyPoolSharedEgressOrderEnabled() ||
    !hasProxyRefusals()
  )
    return null;
  try {
    const row = await executor.queryOne<{ provider?: string }>(
      "SELECT provider FROM provider_connections WHERE id = $1",
      [options.scopeIdFilter]
    );
    return typeof row?.provider === "string" && row.provider ? row.provider : null;
  } catch {
    return null;
  }
}

export async function resolveProxyForConnectionFromRegistry(connectionId: string) {
  const executor = db();

  const account = await resolveScopePoolInternal(executor, "account", connectionId, {
    rotationScopeId: connectionId,
    scopeIdFilter: connectionId,
  });
  if (account) return account;

  const connection = await executor.queryOne<{ provider?: string }>(
    "SELECT provider FROM provider_connections WHERE id = $1",
    [connectionId]
  );

  if (connection?.provider) {
    const provider = await resolveScopePoolInternal(executor, "provider", connection.provider, {
      rotationScopeId: connection.provider,
      scopeIdFilter: connection.provider,
    });
    if (provider) return provider;
  }

  const global = await resolveScopePoolInternal(executor, "global", null, {
    rotationScopeId: normalizeRotationScopeId("global", null),
    matchAnyScopeId: true,
  });
  if (global) return global;

  return null;
}

export async function resolveProxyForScopeFromRegistry(scope: string, scopeId?: string | null) {
  const executor = db();
  const normalizedScope = normalizeScope(scope);

  if (normalizedScope === "global") {
    return resolveScopePoolInternal(executor, "global", null, {
      rotationScopeId: normalizeRotationScopeId("global", null),
      matchAnyScopeId: true,
    });
  }

  const normalizedScopeId = scopeId || null;
  if (!normalizedScopeId) return null;

  return resolveScopePoolInternal(executor, normalizedScope, normalizedScopeId, {
    rotationScopeId: normalizeRotationScopeId(normalizedScope, normalizedScopeId),
    scopeIdFilter: normalizedScopeId,
  });
}
