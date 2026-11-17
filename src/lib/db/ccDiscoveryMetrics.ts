/**
 * cc-discovery usage metrics — aggregate counters for the Claude Code
 * discovery-alias feature (see src/lib/ccDiscoveryAliasResolve.ts and
 * src/app/api/v1/models/catalog.ts).
 *
 * Tracks:
 *  - how many requests were served after resolving a `claude/…` mirror id
 *    back to its real model/combo (per-total and per-model breakdown)
 *  - how many `GET /v1/models` catalog hits came from a Claude Code client
 *    (detected by the `claude-cli` User-Agent substring, the same signal
 *    open-sse/utils/bypassHandler.ts already uses)
 *
 * Counters live in the `cc_discovery_metrics` table (metric_key, count).
 *
 * Every write is best-effort: a DB hiccup here must never break the request
 * it is instrumenting (mirrors src/lib/db/pluginMetrics.ts).
 */
import { db } from "./pg";

const TOTAL_KEY = "req:total";
const HIT_KEY = "discovery:hits";
const MODEL_KEY_PREFIX = "req:model:";

export interface CcDiscoveryMetrics {
  aliasRequests: number;
  discoveryHits: number;
  byModel: Record<string, number>;
}

function modelKey(realModelId: string): string {
  return `${MODEL_KEY_PREFIX}${realModelId}`;
}

async function incrementCounter(key: string): Promise<void> {
  // Atomic upsert increment — a single statement so two concurrent requests
  // never lose a count the way a read-then-write pair would.
  await db().execute(
    `INSERT INTO cc_discovery_metrics (metric_key, count) VALUES ($1, 1)
     ON CONFLICT (metric_key) DO UPDATE SET count = cc_discovery_metrics.count + 1`,
    [key]
  );
}

/**
 * Record one request served via a resolved `claude/…` discovery alias.
 * `realModelId` is the id AFTER stripping (e.g. `kimi/kimi-k2.6`, `my-combo`).
 * Never throws — a metrics failure must not affect the request it instruments.
 */
export async function incrementCcAliasRequestCount(realModelId: string): Promise<void> {
  try {
    await incrementCounter(TOTAL_KEY);
    if (typeof realModelId === "string" && realModelId.length > 0) {
      await incrementCounter(modelKey(realModelId));
    }
  } catch {
    // Best-effort: DB hiccup should never break the request it instruments.
  }
}

/**
 * Record one `GET /v1/models` hit whose User-Agent identified it as a
 * Claude Code discovery request.
 */
export async function incrementCcDiscoveryHitCount(): Promise<void> {
  try {
    await incrementCounter(HIT_KEY);
  } catch {
    // Best-effort — same rationale as incrementCcAliasRequestCount.
  }
}

/**
 * Read the aggregated cc-discovery metrics. Never throws — returns the
 * zero-value shape on any DB failure so a monitoring read never 500s.
 */
export async function getCcDiscoveryMetrics(): Promise<CcDiscoveryMetrics> {
  try {
    const rows = await db().query<{ metric_key: string; count: number }>(
      "SELECT metric_key, count FROM cc_discovery_metrics"
    );

    let aliasRequests = 0;
    let discoveryHits = 0;
    const byModel: Record<string, number> = {};

    for (const row of rows) {
      const value = Number(row.count);
      const count = Number.isFinite(value) && value >= 0 ? value : 0;

      if (row.metric_key === TOTAL_KEY) {
        aliasRequests = count;
      } else if (row.metric_key === HIT_KEY) {
        discoveryHits = count;
      } else if (row.metric_key.startsWith(MODEL_KEY_PREFIX)) {
        byModel[row.metric_key.slice(MODEL_KEY_PREFIX.length)] = count;
      }
    }

    return { aliasRequests, discoveryHits, byModel };
  } catch {
    return { aliasRequests: 0, discoveryHits: 0, byModel: {} };
  }
}
