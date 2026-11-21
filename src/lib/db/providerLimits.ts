import {
  sanitizeProviderBillingStatus,
  type ProviderBillingStatus,
} from "@/shared/utils/providerBilling";
import { isCloud } from "./core";
import { db, type DbExecutor } from "./pg";
import { jsonValueParam } from "./pgJsonText";
import { parseCodexPaidCredits, type CodexPaidCredits } from "@/lib/providers/codexPaidCredits";

type JsonRecord = Record<string, unknown>;

export interface ProviderLimitsCacheEntry {
  quotas: JsonRecord | null;
  modelQuotas?: JsonRecord;
  plan: unknown;
  message: string | null;
  fetchedAt: string;
  source?: string | null;
  bankedResetCredits?: number;
  paidCredits?: CodexPaidCredits;
  billing?: ProviderBillingStatus;
  quotaGroups?: Array<Record<string, unknown>>;
  limitReached?: boolean;
  sparkLimitReached?: boolean;
  rateLimitReachedType?: string;
}

function toRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function sanitizeCacheEntryForStorage(entry: ProviderLimitsCacheEntry): ProviderLimitsCacheEntry {
  const { billing: rawBilling, ...rest } = entry;
  const billing = sanitizeProviderBillingStatus(rawBilling);
  return billing ? { ...rest, billing } : rest;
}

function normalizeOptionalCacheFields(record: JsonRecord): Partial<ProviderLimitsCacheEntry> {
  const bankedResetCredits = Number(record.bankedResetCredits);
  const paidCredits = parseCodexPaidCredits(record.paidCredits);
  const billing = sanitizeProviderBillingStatus(record.billing);
  const modelQuotas = toRecord(record.modelQuotas);
  return {
    ...(modelQuotas ? { modelQuotas } : {}),
    ...(typeof record.limitReached === "boolean" ? { limitReached: record.limitReached } : {}),
    ...(typeof record.sparkLimitReached === "boolean"
      ? { sparkLimitReached: record.sparkLimitReached }
      : {}),
    ...(typeof record.rateLimitReachedType === "string"
      ? { rateLimitReachedType: record.rateLimitReachedType }
      : {}),
    ...(Number.isFinite(bankedResetCredits) ? { bankedResetCredits } : {}),
    ...(paidCredits ? { paidCredits } : {}),
    ...(billing ? { billing } : {}),
    ...(Array.isArray(record.quotaGroups)
      ? { quotaGroups: record.quotaGroups as Array<Record<string, unknown>> }
      : {}),
  };
}
function normalizeCacheEntry(value: unknown): ProviderLimitsCacheEntry | null {
  const record = toRecord(value);
  if (!record) return null;

  const fetchedAt =
    typeof record.fetchedAt === "string" && record.fetchedAt.trim() ? record.fetchedAt : null;
  if (!fetchedAt) return null;

  return {
    quotas: toRecord(record.quotas),
    ...normalizeOptionalCacheFields(record),
    plan: record.plan ?? null,
    message: typeof record.message === "string" ? record.message : null,
    fetchedAt,
    source: typeof record.source === "string" ? record.source : null,
  };
}

export async function getProviderLimitsCache(
  connectionId: string
): Promise<ProviderLimitsCacheEntry | null> {
  if (isCloud) return null;
  const row = await db().queryOne<{ data: unknown }>(
    "SELECT data FROM connection_limits_cache WHERE connection_id = $1",
    [connectionId]
  );
  return row ? normalizeCacheEntry(row.data) : null;
}

export async function getAllProviderLimitsCache(): Promise<Record<string, ProviderLimitsCacheEntry>> {
  if (isCloud) return {};
  const rows = await db().query<{ connection_id: string; data: unknown }>(
    "SELECT connection_id, data FROM connection_limits_cache"
  );

  const result: Record<string, ProviderLimitsCacheEntry> = {};
  for (const row of rows) {
    const parsed = normalizeCacheEntry(row.data);
    if (parsed) {
      result[row.connection_id] = parsed;
    }
  }
  return result;
}

// The row is written only while its connection exists: the table has a foreign key to
// provider_connections, and a refresh that finishes after the connection was deleted
// must not fail (or resurrect an orphan) — it is simply dropped.
async function upsertEntry(
  executor: DbExecutor,
  connectionId: string,
  entry: ProviderLimitsCacheEntry
): Promise<void> {
  await executor.execute(
    `INSERT INTO connection_limits_cache (connection_id, data, updated_at)
     SELECT $1::text, $2::jsonb, now()
      WHERE EXISTS (SELECT 1 FROM provider_connections WHERE id = $1::text)
     ON CONFLICT (connection_id) DO UPDATE
       SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
    [connectionId, jsonValueParam(entry)]
  );
}

export async function setProviderLimitsCache(
  connectionId: string,
  entry: ProviderLimitsCacheEntry
): Promise<ProviderLimitsCacheEntry> {
  const sanitized = sanitizeCacheEntryForStorage(entry);
  if (isCloud) return sanitized;
  await upsertEntry(db(), connectionId, sanitized);
  return sanitized;
}

export async function setProviderLimitsCacheBatch(
  entries: Array<{ connectionId: string; entry: ProviderLimitsCacheEntry }>
): Promise<number> {
  if (isCloud || entries.length === 0) return 0;
  await db().transaction(async (tx) => {
    for (const item of entries) {
      await upsertEntry(tx, item.connectionId, sanitizeCacheEntryForStorage(item.entry));
    }
  });
  return entries.length;
}

export async function deleteProviderLimitsCache(connectionId: string): Promise<void> {
  if (isCloud) return;
  await db().execute("DELETE FROM connection_limits_cache WHERE connection_id = $1", [
    connectionId,
  ]);
}
