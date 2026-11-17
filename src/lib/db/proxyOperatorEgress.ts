// Operator-provided dated egress observations per pool member (`proxy_operator_egress`).
//
// All SQL for the operator-egress table lives here, never outside `src/lib/db/`.
// The table is keyed by entry point (host, port) + observed address, with the same
// normalization as the journal reader (trim, strip one bracket pair, lowercase;
// port 1-65535). A pushed address that cannot normalize is rejected with its reason,
// never stored. Rows unknown to the proxy registry are kept while fresh (the registry
// can change under the rows; only the window decides) and purged at expiry.
//
// Growth is bounded at every write, in one transaction, in this order:
// (1) purge stale rows, (2) keep the 10 newest rows per touched member,
// (3) past 2000 total rows, evict the oldest rows first. Surplus rows are counted
// in `rejected` with `reason: "cap-evicted"` — a push is a dated observation,
// never a batch error.
import { db, ts, type DbExecutor } from "@/lib/db/pg";
import { normalizeProxyHostForLog } from "../proxyLogHost";
import { normalizeEgressAddress } from "@/shared/network/egressAddress";

export const OPERATOR_EGRESS_MAX_ADDRESSES_PER_MEMBER = 10;
export const OPERATOR_EGRESS_MAX_ROWS_TOTAL = 2000;
export const OPERATOR_EGRESS_DEFAULT_WINDOW_HOURS = 24;
export const OPERATOR_EGRESS_MIN_WINDOW_HOURS = 1;
export const OPERATOR_EGRESS_MAX_WINDOW_HOURS = 168;
export const OPERATOR_EGRESS_FUTURE_TOLERANCE_MS = 5 * 60_000;

export type OperatorEgressPushRow = {
  host: string;
  port: number;
  addresses: string[];
  observedAt: string;
};

export type OperatorEgressRejection = {
  member: string;
  address?: string;
  reason: string;
};

export type OperatorEgressUpsertResult = {
  stored: number;
  ignored: number;
  rejected: OperatorEgressRejection[];
};

export type OperatorEgressRead = {
  addresses: Set<string>;
  freshest: { address: string; at: string } | null;
};

let warnedInvalidWindow = false;

/** Test-only: let the next invalid window warn again. */
export function __resetOperatorEgressWarnedForTesting(): void {
  warnedInvalidWindow = false;
}

/**
 * Observation window in hours, read on every read (never cached: the expiry
 * check needs the current value). Out-of-range, non-numeric, or empty input
 * falls back to 24 h with a single process-wide warning, never a throw.
 */
export function readOperatorEgressWindowHours(): number {
  const raw = process.env.PROXY_OPERATOR_EGRESS_WINDOW_HOURS;
  if (raw === undefined) return OPERATOR_EGRESS_DEFAULT_WINDOW_HOURS;
  const trimmed = raw.trim();
  if (!trimmed) {
    if (!warnedInvalidWindow) {
      warnedInvalidWindow = true;
      console.warn(
        `[proxyOperatorEgress] Ignoring invalid PROXY_OPERATOR_EGRESS_WINDOW_HOURS=${JSON.stringify(raw)}: using ${OPERATOR_EGRESS_DEFAULT_WINDOW_HOURS} h`
      );
    }
    return OPERATOR_EGRESS_DEFAULT_WINDOW_HOURS;
  }
  const parsed = Number(trimmed);
  if (
    !Number.isFinite(parsed) ||
    !Number.isInteger(Math.floor(parsed)) ||
    parsed < OPERATOR_EGRESS_MIN_WINDOW_HOURS ||
    parsed > OPERATOR_EGRESS_MAX_WINDOW_HOURS
  ) {
    if (!warnedInvalidWindow) {
      warnedInvalidWindow = true;
      console.warn(
        `[proxyOperatorEgress] Ignoring invalid PROXY_OPERATOR_EGRESS_WINDOW_HOURS=${JSON.stringify(raw)}: using ${OPERATOR_EGRESS_DEFAULT_WINDOW_HOURS} h`
      );
    }
    return OPERATOR_EGRESS_DEFAULT_WINDOW_HOURS;
  }
  return Math.floor(parsed);
}

/**
 * Whether a host:port couple names a registry member. Exact lookup first;
 * the fallback accepts any syntactically usable couple absent from the
 * registry — callers count those rows `ignored`, never a batch error.
 */
export async function isKnownProxyMember(
  host: string,
  port: number,
  executor: DbExecutor = db()
): Promise<boolean> {
  try {
    const normalized = normalizeProxyHostForLog(host);
    if (!normalized || !Number.isInteger(port) || port < 1 || port > 65535) return false;
    const row = await executor.queryOne(
      "SELECT id FROM proxy_registry WHERE host = $1 AND port = $2 LIMIT 1",
      [normalized, port]
    );
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Store one batch of operator observations. All addresses in a batch share the
 * batch `observedAt`; the freshest timestamp wins per address through an atomic
 * upsert (no read-then-write, safe under concurrent pushes). One atomic
 * statement per row, one transaction per call. A transaction-scoped advisory
 * lock serialises concurrent pushes, so the eviction caps below see a stable
 * table and two batches cannot deadlock on each other's rows.
 */
export async function upsertOperatorEgress(
  rows: OperatorEgressPushRow[]
): Promise<OperatorEgressUpsertResult> {
  const result: OperatorEgressUpsertResult = { stored: 0, ignored: 0, rejected: [] };
  if (rows.length === 0) return result;
  const nowIso = new Date().toISOString();
  const touched = new Set<string>();
  await db().transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('proxy_operator_egress'))");
    for (const row of rows) {
      const normalizedHost = normalizeProxyHostForLog(row.host);
      const port = Number(row.port);
      const observedAt = typeof row.observedAt === "string" ? ts(row.observedAt) : null;
      if (!normalizedHost || !Number.isInteger(port) || port < 1 || port > 65535) {
        result.rejected.push({ member: `${row.host}:${row.port}`, reason: "invalid-member" });
        continue;
      }
      if (observedAt === null) {
        // A string that is not a parseable date used to be stored as given; timestamptz cannot.
        result.rejected.push({
          member: `${normalizedHost}:${port}`,
          reason: "invalid-observed-at",
        });
        continue;
      }
      if (!(await isKnownProxyMember(row.host, port, tx))) result.ignored += row.addresses.length;
      for (const rawAddress of row.addresses) {
        const normalized = normalizeEgressAddress(rawAddress);
        if (normalized === null) {
          result.rejected.push({
            member: `${normalizedHost}:${port}`,
            address: String(rawAddress),
            reason: "unusable-address",
          });
          continue;
        }
        await tx.execute(
          `INSERT INTO proxy_operator_egress (host, port, address, observed_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (host, port, address)
           DO UPDATE SET observed_at = GREATEST(proxy_operator_egress.observed_at, EXCLUDED.observed_at)`,
          [normalizedHost, port, normalized, observedAt]
        );
        result.stored++;
        touched.add(`${normalizedHost}:${port}`);
      }
    }
    await evictOperatorEgressLocked(tx, touched, nowIso, result.rejected);
  });
  return result;
}

async function evictOperatorEgressLocked(
  tx: DbExecutor,
  touched: Set<string>,
  nowIso: string,
  rejected: OperatorEgressRejection[]
): Promise<void> {
  const windowMs = readOperatorEgressWindowHours() * 60 * 60_000;
  const cutoff = new Date(Date.parse(nowIso) - windowMs).toISOString();
  // (1) Purge stale rows.
  await tx.execute("DELETE FROM proxy_operator_egress WHERE observed_at < $1", [cutoff]);
  // (2) Per-member cap: keep the 10 newest rows per touched member. Evicted
  // rows are counted; `address` breaks observed_at ties deterministically.
  for (const key of touched) {
    const separator = key.lastIndexOf(":");
    const host = key.slice(0, separator);
    const port = Number(key.slice(separator + 1));
    const evicted = await tx.query<{ address: string }>(
      `DELETE FROM proxy_operator_egress
       WHERE host = $1 AND port = $2
         AND address IN (
           SELECT address FROM proxy_operator_egress
           WHERE host = $1 AND port = $2
           ORDER BY observed_at DESC, address DESC
           OFFSET $3
         )
       RETURNING address`,
      [host, port, OPERATOR_EGRESS_MAX_ADDRESSES_PER_MEMBER]
    );
    for (const row of evicted) {
      rejected.push({ member: key, address: row.address, reason: "cap-evicted" });
    }
  }
  // (3) Total cap: past 2000 rows, evict the oldest rows first.
  const total = Number(
    (await tx.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM proxy_operator_egress"))?.n ?? 0
  );
  if (total > OPERATOR_EGRESS_MAX_ROWS_TOTAL) {
    const overflow = total - OPERATOR_EGRESS_MAX_ROWS_TOTAL;
    const evicted = await tx.query<{ host: string; port: number; address: string }>(
      `DELETE FROM proxy_operator_egress t
       USING (
         SELECT host, port, address FROM proxy_operator_egress
         ORDER BY observed_at ASC, address ASC LIMIT $1
       ) old
       WHERE t.host = old.host AND t.port = old.port AND t.address = old.address
       RETURNING t.host, t.port, t.address`,
      [overflow]
    );
    for (const row of evicted) {
      rejected.push({
        member: `${row.host}:${row.port}`,
        address: row.address,
        reason: "cap-evicted",
      });
    }
  }
}

/**
 * Fresh operator-observed addresses for one member. Direct read, never cached:
 * a row that crosses the window must disappear on the next read, not linger
 * behind a TTL. Rows inside the +5 min future tolerance still read as fresh so
 * a push accepted at the edge stays visible. Every address is re-normalized
 * through the shared normalizer.
 */
export async function readOperatorEgressForMember(
  host: string,
  port: number,
  nowMs: number = Date.now()
): Promise<OperatorEgressRead> {
  const empty: OperatorEgressRead = { addresses: new Set(), freshest: null };
  try {
    const normalizedHost = normalizeProxyHostForLog(host);
    if (!normalizedHost || !Number.isInteger(port) || port < 1 || port > 65535) return empty;
    const windowMs = readOperatorEgressWindowHours() * 60 * 60_000;
    const cutoff = new Date(nowMs - windowMs).toISOString();
    const rows = await db().query<{ address: string; observed_at: string }>(
      `SELECT address, observed_at FROM proxy_operator_egress
       WHERE host = $1 AND port = $2 AND observed_at >= $3
       ORDER BY observed_at DESC, address ASC`,
      [normalizedHost, port, cutoff]
    );
    for (const row of rows) {
      const normalized = normalizeEgressAddress(row.address);
      if (normalized === null) continue;
      if (Date.parse(row.observed_at) - nowMs > OPERATOR_EGRESS_FUTURE_TOLERANCE_MS) continue;
      empty.addresses.add(normalized);
      if (!empty.freshest) empty.freshest = { address: normalized, at: row.observed_at };
    }
    return empty;
  } catch {
    return empty;
  }
}
