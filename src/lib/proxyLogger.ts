/**
 * Proxy Logger — Hybrid in-memory + SQLite persistence
 *
 * Keeps a fast in-memory ring buffer for real-time dashboard AND
 * persists to SQLite so logs survive server restarts.
 *
 * Pattern follows callLogs.js (T-15 decomposition).
 */
import { v4 as uuidv4 } from "uuid";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/errorSanitization.ts";
import { sanitizeTimingMs } from "@omniroute/open-sse/utils/timingMs.ts";
import { db, ts } from "./db/pg";
import { stripNul } from "./db/pgJsonText";
import { normalizeProxyHostForLog } from "./proxyLogHost";

// Re-exported for existing callers; the helper lives in a zero-import leaf so DB modules
// can use it without loading this module (which hydrates from the database at import time).
export { normalizeProxyHostForLog };

const isCloud = typeof globalThis.caches === "object" && globalThis.caches !== null;
const shouldPersistToDisk = !isCloud;

const MAX_IN_MEMORY_ENTRIES = 200;

interface ProxyInfo {
  type: string;
  host: string;
  port: number | string;
  /** Registry name (e.g. `murphy-eu-fr`) — carried by registry resolution so the
   *  proxy log can identify a leg even when many entries share host:port. */
  name?: string;
}

interface ProxyLogEntry {
  id: string;
  timestamp: string;
  status: string;
  proxy: ProxyInfo | null;
  level: string;
  levelId: string | null;
  provider: string | null;
  targetUrl: string | null;
  clientIp: string | null;
  /** Outbound/egress IP the upstream actually saw (null until probed). The
   * historical clientIp is the INBOUND IP (x-forwarded-for); egressIp answers
   * "by which IP is this account leaving" — critical for rotating providers. */
  egressIp: string | null;
  latencyMs: number;
  error: string | null;
  connectionId: string | null;
  comboId: string | null;
  // `account` is the configured connection id prefix (connectionId slice);
  // `rotationAccount` is the masked id of the rotation account that served the
  // request (multi-account anonymous rotation only, null otherwise). Both stay
  // masked prefixes — never a full account id.
  account: string | null;
  /** Masked serving-account id of the rotation executor (null unless set). */
  rotationAccount: string | null;
  /** Request correlation id shared with call_logs (null unless set). */
  correlationId: string | null;
  tlsFingerprint: boolean;
  /** HTTP status the provider actually returned; null when no response was received. */
  upstreamStatus: number | null;
  /** 1-based position of this row within its request journal; null for unjournaled rows. */
  attemptNumber: number | null;
  /** Outcome of this send within its request journal; null for unjournaled rows. */
  attemptIssue: "served" | "abandoned" | null;
  /** Send start -> response headers received; null when unknown (network throw). */
  headersMs: number | null;
  /** Send start -> first useful body byte; null until the byte arrives. */
  firstChunkMs: number | null;
}

type ProxyLogInput = Partial<ProxyLogEntry> & {
  publicIp?: string | null;
};

interface ProxyLogFilters {
  status?: string;
  type?: string;
  provider?: string;
  level?: string;
  search?: string;
  limit?: number;
}

const proxyLogs: ProxyLogEntry[] = [];

// `public_ip` is the historical SQLite column name; API/UI expose the value as clientIp.

// ──────────────── Startup: hydrate from DB ────────────────

async function loadFromDb(): Promise<void> {
  if (!shouldPersistToDisk) return;
  try {
    const rows = await db().query<any>(
      `SELECT * FROM proxy_logs ORDER BY "timestamp" DESC LIMIT $1`,
      [MAX_IN_MEMORY_ENTRIES]
    );

    // Rows logged while the query was in flight are newer and already at the
    // front of the ring; the hydrated (older) rows go behind them.
    const known = new Set(proxyLogs.map((l) => l.id));
    const hydrated: ProxyLogEntry[] = [];
    for (const row of rows) {
      if (known.has(row.id)) continue;
      hydrated.push({
        id: row.id,
        timestamp: row.timestamp,
        status: row.status || "success",
        proxy: row.proxy_host
          ? {
              type: row.proxy_type,
              host: row.proxy_host,
              port: row.proxy_port,
              name: row.proxy_name || undefined,
            }
          : null,
        level: row.level || "direct",
        levelId: row.level_id || null,
        provider: row.provider || null,
        targetUrl: row.target_url || null,
        clientIp: row.public_ip || null,
        egressIp: row.egress_ip || null,
        latencyMs: row.latency_ms || 0,
        error: row.error || null,
        connectionId: row.connection_id || null,
        comboId: row.combo_id || null,
        account: row.account || null,
        rotationAccount: row.rotation_account || null,
        correlationId: row.correlation_id || null,
        tlsFingerprint: row.tls_fingerprint === true || row.tls_fingerprint === 1,
        upstreamStatus: typeof row.upstream_status === "number" ? row.upstream_status : null,
        attemptNumber: typeof row.attempt_number === "number" ? row.attempt_number : null,
        attemptIssue:
          row.attempt_issue === "served" || row.attempt_issue === "abandoned"
            ? row.attempt_issue
            : null,
        headersMs: sanitizeTimingMs(row.headers_ms),
        firstChunkMs: sanitizeTimingMs(row.first_chunk_ms),
      });
    }

    proxyLogs.push(...hydrated);
    if (proxyLogs.length > MAX_IN_MEMORY_ENTRIES) proxyLogs.length = MAX_IN_MEMORY_ENTRIES;

    if (hydrated.length > 0) {
      console.log(`[proxyLogger] Loaded ${hydrated.length} proxy logs from the database`);
    }
  } catch (err: any) {
    console.warn(
      "[proxyLogger] Failed to load from DB:",
      sanitizeErrorMessage(err) || "Proxy log hydration failed"
    );
  }
}

/** Resolves once the ring buffer has been hydrated from the database (never rejects). */
export const proxyLogsHydrated: Promise<void> = loadFromDb();

// Default-off override that restores the verbose [ProxyEgress] console line (raw
// client/egress IPs + account prefix). Kept OFF by default so the process log leaks
// neither IPs nor the account prefix. Deliberately NOT coupled to debugMode
// (src/lib/db/settings.ts defaults debugMode to true) — this verbosity is opt-in only.
// Storage (in-memory ring buffer + SQLite) is untouched and always keeps full IPs.

/** Read at call time so tests can toggle it between imports. */
export function isProxyLogIncludeIps(): boolean {
  return process.env.PROXY_LOG_INCLUDE_IPS === "true" || process.env.PROXY_LOG_INCLUDE_IPS === "1";
}

/**
 * Pure formatter for the [ProxyEgress] process-log line (#10348). At the default level it
 * emits a short, IP/prefix-free summary; when details are opted in it restores the full
 * verbose line including client/egress IPs and the account. Extracted as a separate
 * function so it is unit-testable without patching console.log and so the change never
 * grows logProxyEvent itself.
 */
export function formatProxyEgressConsoleLine(params: {
  provider: string | null;
  account: string | null;
  clientIp: string | null;
  egressIp: string | null;
  level: string;
  proxyHost: string | null | undefined;
  proxyName?: string | null | undefined;
  status: string;
  includeDetails?: boolean;
}): string {
  const provider = params.provider || "-";
  const status = params.status;
  if (!params.includeDetails) {
    return `[ProxyEgress] ${provider} status=${status}`;
  }
  const proxy = params.proxyHost ? `:${params.proxyHost}` : "";
  const name = params.proxyName ? ` name=${params.proxyName}` : "";
  return (
    `[ProxyEgress] ${provider}/${params.account || "-"} ` +
    `in=${params.clientIp || "?"} out=${params.egressIp || "?"} ` +
    `proxy=${params.level}${proxy}${name} status=${status}`
  );
}

// ──────────────── Log a proxy event ────────────────

export function logProxyEvent(entry: ProxyLogInput) {
  const safeError =
    entry.error === null || entry.error === undefined || entry.error === ""
      ? null
      : sanitizeErrorMessage(entry.error) || "Proxy request failed";
  const log: ProxyLogEntry = {
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    status: entry.status || "success",
    proxy: entry.proxy
      ? {
          ...entry.proxy,
          host: normalizeProxyHostForLog(entry.proxy.host) ?? entry.proxy.host,
        }
      : null,
    level: entry.level || "direct",
    levelId: entry.levelId || null,
    provider: entry.provider || null,
    targetUrl: entry.targetUrl || null,
    clientIp: entry.clientIp ?? entry.publicIp ?? null,
    egressIp: entry.egressIp ?? null,
    latencyMs: entry.latencyMs || 0,
    error: safeError,
    connectionId: entry.connectionId || null,
    comboId: entry.comboId || null,
    account: entry.account || null,
    rotationAccount: entry.rotationAccount || null,
    correlationId: entry.correlationId || null,
    tlsFingerprint: entry.tlsFingerprint || false,
    upstreamStatus: entry.upstreamStatus ?? null,
    attemptNumber:
      typeof entry.attemptNumber === "number" && Number.isInteger(entry.attemptNumber)
        ? entry.attemptNumber
        : null,
    attemptIssue:
      entry.attemptIssue === "served" || entry.attemptIssue === "abandoned"
        ? entry.attemptIssue
        : null,
    headersMs: sanitizeTimingMs(entry.headersMs),
    firstChunkMs: sanitizeTimingMs(entry.firstChunkMs),
  };

  // Structured egress line so the operator can confirm, in the proxy logs, which
  // IP each account is entering (clientIp) and leaving (egressIp) by.
  if (log.proxy || log.egressIp) {
    console.log(
      formatProxyEgressConsoleLine({
        provider: log.provider,
        account: log.account,
        clientIp: log.clientIp,
        egressIp: log.egressIp,
        level: log.level,
        proxyHost: log.proxy?.host,
        proxyName: log.proxy?.name,
        status: log.status,
        includeDetails: isProxyLogIncludeIps(),
      })
    );
  }

  // 1. In-memory ring buffer (newest first)
  proxyLogs.unshift(log);
  if (proxyLogs.length > MAX_IN_MEMORY_ENTRIES) {
    proxyLogs.length = MAX_IN_MEMORY_ENTRIES;
  }

  // 2. Queue for background batch persistence (SQLite / Redis)
  if (shouldPersistToDisk) {
    enqueueProxyLog(log);
  }

  return log;
}

// ──────────────── Background Batch Persistence ────────────────

const BATCH_FLUSH_INTERVAL_MS = 1000;
const BATCH_SIZE_THRESHOLD = 100;
const WRITE_CHUNK_ROWS = 200;
const PROXY_LOG_COLUMNS = [
  "id",
  '"timestamp"',
  "status",
  "proxy_type",
  "proxy_host",
  "proxy_port",
  "proxy_name",
  "level",
  "level_id",
  "provider",
  "target_url",
  "public_ip",
  "egress_ip",
  "latency_ms",
  "error",
  "connection_id",
  "combo_id",
  "account",
  "rotation_account",
  "correlation_id",
  "tls_fingerprint",
  "upstream_status",
  "attempt_number",
  "attempt_issue",
  "headers_ms",
  "first_chunk_ms",
];

let pendingLogsQueue: ProxyLogEntry[] = [];
let batchTimer: NodeJS.Timeout | null = null;
// Generation guard: clearProxyLogs() bumps the counter, and a flush that was
// in flight before the clear does not re-insert its rows.
let proxyLogGeneration = 0;
let inFlightFlush: Promise<void> = Promise.resolve();

function logProxyBatchFailure(err: unknown): void {
  console.warn(
    "[proxyLogger] Failed to write proxy log batch to disk:",
    sanitizeErrorMessage(err) || "Proxy log persistence failed"
  );
}

function nullableInt(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function proxyRowParams(item: ProxyLogEntry): unknown[] {
  const port = item.proxy?.port ? Number(item.proxy.port) : null;
  return [
    item.id,
    ts(item.timestamp),
    item.status,
    item.proxy?.type || null,
    item.proxy?.host || null,
    port !== null && Number.isFinite(port) ? Math.round(port) : null,
    item.proxy?.name || null,
    item.level,
    item.levelId,
    item.provider,
    item.targetUrl,
    item.clientIp,
    item.egressIp,
    nullableInt(item.latencyMs) ?? 0,
    item.error === null ? null : stripNul(item.error),
    item.connectionId,
    item.comboId,
    item.account,
    item.rotationAccount,
    item.correlationId,
    item.tlsFingerprint === true,
    nullableInt(item.upstreamStatus),
    nullableInt(item.attemptNumber),
    item.attemptIssue,
    nullableInt(item.headersMs),
    nullableInt(item.firstChunkMs),
  ];
}

async function writeProxyBatch(batch: ProxyLogEntry[]): Promise<void> {
  await db().transaction(async (tx) => {
    for (let start = 0; start < batch.length; start += WRITE_CHUNK_ROWS) {
      const chunk = batch.slice(start, start + WRITE_CHUNK_ROWS);
      const params: unknown[] = [];
      const tuples = chunk.map((item) => {
        const values = proxyRowParams(item);
        const base = params.length;
        params.push(...values);
        return `(${values.map((_, i) => `$${base + i + 1}`).join(", ")})`;
      });
      await tx.execute(
        `INSERT INTO proxy_logs (${PROXY_LOG_COLUMNS.join(", ")}) VALUES ${tuples.join(", ")}`,
        params
      );
    }
  });
}

function ensureBatchTimer() {
  if (batchTimer) return;
  batchTimer = setInterval(() => {
    void flushProxyLogsSync();
  }, BATCH_FLUSH_INTERVAL_MS);
  if (typeof batchTimer.unref === "function") {
    batchTimer.unref();
  }
}

function enqueueProxyLog(log: ProxyLogEntry) {
  pendingLogsQueue.push(log);
  ensureBatchTimer();
  if (pendingLogsQueue.length >= BATCH_SIZE_THRESHOLD) {
    void flushProxyLogsSync();
  }
}

/**
 * Persists the queued proxy log entries. The name is historical; the write is
 * asynchronous now, so await the returned promise when the rows must be on disk
 * (shutdown, tests).
 */
export function flushProxyLogsSync(): Promise<void> {
  if (pendingLogsQueue.length === 0) return inFlightFlush;
  const batch = pendingLogsQueue;
  pendingLogsQueue = [];
  const generation = proxyLogGeneration;

  // 1. If Redis driver is active, asynchronously publish batch to Redis Stream/Channel
  if (process.env.QUOTA_STORE_DRIVER === "redis" || process.env.QUOTA_STORE_REDIS_URL) {
    try {
      import("@/lib/quota/redisQuotaStore")
        .then(({ getRedisQuotaStore }) => {
          const store = getRedisQuotaStore(process.env.QUOTA_STORE_REDIS_URL || "");
          const client = (store as any)?.client;
          if (client && typeof client.publish === "function") {
            for (const entry of batch) {
              client.publish("omniroute:proxy_logs", JSON.stringify(entry)).catch(() => {});
            }
          }
        })
        .catch(() => {});
    } catch {
      /* ignore redis pub errors */
    }
  }

  // Writes run in order so a later batch's timing patch finds its row.
  inFlightFlush = inFlightFlush.then(async () => {
    if (generation !== proxyLogGeneration) return;
    try {
      await writeProxyBatch(batch);
    } catch (err: any) {
      logProxyBatchFailure(err);
    }
  });
  return inFlightFlush;
}

// ──────────────── Deferred timing patch ────────────────

// Bounded join key for late first-chunk arrivals: log id -> queued entry ref.
// Registered only when the first byte is still unknown at journal time; every
// entry leaves through exactly one path below (notify, settle-without-byte,
// cancel/error, cap eviction, clear). Cap mirrors the ring buffer so the
// registry never retains more than memory already does.
export const TIMING_LINK_CAP = 200;
const pendingFirstChunk = new Map<string, ProxyLogEntry>();

function evictOldestTimingLink(): void {
  const oldest = pendingFirstChunk.keys().next();
  if (!oldest.done) pendingFirstChunk.delete(oldest.value);
}

/**
 * Totest seam: current registry size (bounded by TIMING_LINK_CAP).
 */
export function pendingFirstChunkSizeForTests(): number {
  return pendingFirstChunk.size;
}

/**
 * Link a journaled row to its still-open upstream body. Called by the journal
 * layer right after logProxyEvent returns the entry, when the first byte has
 * not arrived yet. No-ops (no entry) when the timing is already known or when
 * there is no body to wait for.
 */
export function linkPendingFirstChunk(
  id: string,
  entry: ProxyLogEntry,
  timingKnown: boolean,
  hasBody: boolean
): void {
  if (timingKnown || !hasBody) return;
  if (pendingFirstChunk.size >= TIMING_LINK_CAP) evictOldestTimingLink();
  pendingFirstChunk.set(id, entry);
}

function dropPendingFirstChunk(id: string): void {
  pendingFirstChunk.delete(id);
}

/**
 * Settle a linked row once the first useful body byte arrives (or never does).
 * Before the batch flush the queued object is mutated in place so the INSERT
 * carries the value; after the flush the row is patched by id and the
 * in-memory copy is updated. Every path drops the registry entry.
 * The patch callback keeps this module decoupled from the db writer: the
 * journal/capture layer passes updateAttemptTiming from the owned db module.
 */
export function settlePendingFirstChunk(
  id: string,
  firstChunkMs: number | null,
  patchRow?: (
    id: string,
    patch: { firstChunkMs: number | null },
    timestamp?: string
  ) => boolean | Promise<boolean>
): void {
  const entry = pendingFirstChunk.get(id);
  dropPendingFirstChunk(id);
  if (!entry) return;
  const clean = sanitizeTimingMs(firstChunkMs);
  entry.firstChunkMs = clean;
  if (!shouldPersistToDisk) return;
  if (pendingLogsQueue.includes(entry)) return;
  // Wait for batches already handed to the writer so the row exists when patched.
  void inFlightFlush
    .then(() => patchRow?.(id, { firstChunkMs: clean }, entry.timestamp))
    .catch(() => {
      // Deferred visibility is best-effort; the in-memory copy above stays correct.
    });
}

// ──────────────── Query ────────────────

/**
 * Get proxy logs with optional filters.
 * Reads from in-memory for speed (already hydrated from DB on startup).
 */
export function getProxyLogs(filters: ProxyLogFilters = {}) {
  let logs = [...proxyLogs];

  if (filters.status) {
    if (filters.status === "ok") {
      logs = logs.filter((l) => l.status === "success");
    } else {
      logs = logs.filter((l) => l.status === filters.status);
    }
  }

  if (filters.type) {
    logs = logs.filter((l) => l.proxy?.type === filters.type);
  }

  if (filters.provider) {
    logs = logs.filter((l) => l.provider === filters.provider);
  }

  if (filters.level) {
    logs = logs.filter((l) => l.level === filters.level);
  }

  if (filters.search) {
    const q = filters.search.toLowerCase();
    logs = logs.filter(
      (l) =>
        (l.proxy?.host || "").toLowerCase().includes(q) ||
        (l.proxy?.name || "").toLowerCase().includes(q) ||
        (l.provider || "").toLowerCase().includes(q) ||
        (l.targetUrl || "").toLowerCase().includes(q) ||
        (l.clientIp || "").toLowerCase().includes(q) ||
        (l.egressIp || "").toLowerCase().includes(q) ||
        (l.level || "").toLowerCase().includes(q) ||
        (l.error || "").toLowerCase().includes(q) ||
        (l.account || "").toLowerCase().includes(q)
    );
  }

  const limit = filters.limit || 300;
  return logs.slice(0, limit);
}

// ──────────────── Clear ────────────────

export async function clearProxyLogs(): Promise<void> {
  proxyLogs.length = 0;
  pendingLogsQueue = [];
  pendingFirstChunk.clear();
  // Invalidate flushes queued before this clear so they do not re-insert
  // cleared rows.
  proxyLogGeneration++;

  if (shouldPersistToDisk) {
    try {
      await inFlightFlush;
      await db().execute("DELETE FROM proxy_logs");
    } catch (err: any) {
      console.warn(
        "[proxyLogger] Failed to clear DB:",
        sanitizeErrorMessage(err) || "Proxy log cleanup failed"
      );
    }
  }
}
