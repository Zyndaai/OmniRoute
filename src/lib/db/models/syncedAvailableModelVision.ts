/**
 * Synced-available-model vision lookup (#14081).
 *
 * Custom OpenAI-compatible nodes persist a per-connection `supportsVision`
 * boolean on their `syncedAvailableModels` row (see `detectVisionInput` in
 * `src/lib/providerModels/modelDiscovery.ts`). `/v1/models` already reads
 * that field through `buildSyncedCapabilities()` and reports
 * `capabilities.vision: true`, but the runtime capability resolver
 * (`resolveVisionCapability()` in `src/lib/modelCapabilities.ts`) had no
 * code path back to this table at all, so the Vision Bridge guardrail
 * disagreed with the catalog it feeds.
 *
 * Positive-only by design: a row's `supportsVision` is only ever persisted
 * as `true` (see `normalizeSyncedAvailableModels`), so a missing entry here
 * means "no signal from this source", never "not vision capable" — callers
 * must not use `false` from this helper to downgrade another source's verdict.
 */
import { db } from "../pg";
import { getModelCatalogCacheVersion } from "../readCache";
import { normalizeSyncedAvailableModels } from "./synced";

/** Provider → set of model ids with at least one connection's synced row saying supportsVision:true. */
export type SyncedAvailableModelVisionMap = ReadonlyMap<string, ReadonlySet<string>>;

function collectVisionModelIds(providerId: string, models: unknown): string[] {
  if (!Array.isArray(models) || models.length === 0) return [];
  return normalizeSyncedAvailableModels(models, providerId)
    .filter((model) => model.supportsVision === true)
    .map((model) => model.id);
}

function readVerdictFromMap(
  verdicts: SyncedAvailableModelVisionMap,
  providerId: string,
  modelId: string
): boolean | null {
  return verdicts.get(providerId)?.has(modelId) === true ? true : null;
}

// Throwing bulk read (no `catch → empty map` absorber): a failed read
// reaches the caller's catch, so failures are never stored.
async function buildVisionVerdicts(): Promise<SyncedAvailableModelVisionMap> {
  const rows = await db().query<{ provider: string; models: unknown }>(
    "SELECT provider, models FROM connection_model_sync WHERE models <> '[]'::jsonb"
  );
  const verdicts = new Map<string, Set<string>>();
  for (const row of rows) {
    const rowProviderId = row.provider;
    if (!rowProviderId) continue;
    const visionIds = collectVisionModelIds(rowProviderId, row.models);
    if (visionIds.length === 0) continue;
    let byModel = verdicts.get(rowProviderId);
    if (!byModel) {
      byModel = new Set();
      verdicts.set(rowProviderId, byModel);
    }
    for (const id of visionIds) byModel.add(id);
  }
  return verdicts;
}

// One stored generation: the full provider verdict map with the catalog
// version it was built from. Replacement on version change frees the previous
// map, so the memo never grows past a single entry.
let cachedVisionVerdicts: {
  version: number;
  verdicts: SyncedAvailableModelVisionMap;
} | null = null;

/** Test-only view of the stored verdict generations (0 or 1). */
export function getSyncedVisionVerdictMemoSizeForTests(): number {
  return cachedVisionVerdicts ? 1 : 0;
}

/** Test-only reset so hermetic suites start from an empty memo. */
export function resetSyncedVisionVerdictMemoForTests(): void {
  cachedVisionVerdicts = null;
}

/**
 * Bulk-load every provider's synced-available-model vision verdicts with one
 * query, unioned across all of a provider's connections. Mirrors
 * `listCustomModelVisionOverrides()` so catalog/snapshot generation stays a
 * single bulk read instead of N+1 queries.
 */
export async function listSyncedAvailableModelVision(): Promise<SyncedAvailableModelVisionMap> {
  try {
    return await buildVisionVerdicts();
  } catch {
    return new Map<string, Set<string>>();
  }
}

/**
 * Resolve one provider+model synced-available-model vision verdict. A
 * supplied bulk map avoids a database read for request/build-local capability
 * resolution (mirrors `getCustomModelVisionOverride()`).
 *
 * Positive-only: returns `true` when at least one connection's synced row
 * for this provider+model has `supportsVision === true`, otherwise `null`
 * — never `false`, so this source can never downgrade another one.
 */
export async function getSyncedAvailableModelVision(
  providerId: string,
  modelId: string,
  bulk?: SyncedAvailableModelVisionMap | null
): Promise<boolean | null> {
  if (!providerId || !modelId) return null;
  if (bulk) {
    try {
      return readVerdictFromMap(bulk, providerId, modelId);
    } catch {
      return null;
    }
  }
  try {
    const current = getModelCatalogCacheVersion();
    if (cachedVisionVerdicts?.version === current) {
      return readVerdictFromMap(cachedVisionVerdicts.verdicts, providerId, modelId);
    }
    const verdicts = await buildVisionVerdicts();
    cachedVisionVerdicts = { version: current, verdicts };
    return readVerdictFromMap(verdicts, providerId, modelId);
  } catch {
    return null;
  }
}
