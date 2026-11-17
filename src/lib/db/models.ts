/**
 * db/models.ts — Custom models, synced available models, and model-flag queries.
 * Compat overrides, model aliases, and MITM aliases have moved to sub-modules under
 * models/; this file re-exports their public APIs for backward compatibility.
 */

import { isRetiredGitHubCopilotModelId } from "@omniroute/open-sse/config/providers/registry/github/retiredModels.ts";

import { db } from "./pg";
import { jsonValueParam } from "./pgJsonText";
import { isSyncedAtFresh } from "./models/syncedCatalogFreshness";
import { getProviderConnectionsCount, touchConnectionSyncedModelsAt } from "./providers";
import type { JsonRecord } from "./models/shared";
import {
  normalizeSyncedAvailableModels,
  type SyncedAvailableModel,
  type SyncedAvailableModelInput,
} from "./models/synced";
import {
  clearConnectionSyncedModels,
  deleteEmptySyncRows,
  deleteSyncedAvailableModelsForProvider as deleteSyncedAvailableModelsForProviderInternal,
  finishSyncedAvailableModelsWrite,
  persistCanonicalSyncedAvailableModels,
} from "./models/syncedAvailableModelPersistence";
import { finishModelCatalogWriteWithoutBackup } from "./models/modelCatalogWriteSignals";
import { readAllCatalogColumn, readCatalogColumn, updateCatalogColumn } from "./models/catalogRow";
import {
  readCompatList,
  updateCompatList,
  deepMergeCompatByProtocol,
  compatByProtocolHasEntries,
  isCompatProtocolKey,
  sanitizeUpstreamHeadersMap,
  removeModelCompatOverride,
  mergeModelCompatOverride,
  isOverrideHiddenForModality,
  type CompatByProtocolMap,
  type ModelCompatProtocolKey,
  type ModelCompatOverride,
  type ModelCompatPerProtocol,
} from "./models/compat";

export {
  sanitizeUpstreamHeadersMap,
  getModelCompatOverrides,
  mergeModelCompatOverride,
  removeModelCompatOverride,
  MODEL_COMPAT_PROTOCOL_KEYS,
  type ModelCompatProtocolKey,
  type ModelCompatPerProtocol,
  type ModelCompatOverride,
  type ModelCompatPatch,
} from "./models/compat";
export {
  getModelAliases,
  setModelAlias,
  deleteModelAlias,
  deleteModelAliasesForProvider,
  getManagedModelAliasNames,
  markManagedModelAlias,
  unmarkManagedModelAlias,
} from "./models/aliases";
export { getMitmAlias, setMitmAliasAll } from "./models/mitmAlias";
export type { SyncedAvailableModel } from "./models/synced";
export {
  getCustomModelVisionOverride,
  listCustomModelVisionOverrides,
  buildCustomModelVisionOverrides,
  readCustomModelsByProvider,
  type CustomModelsByProvider,
  type CustomModelVisionOverrideMap,
  type CustomModelVisionOverrideReadOptions,
} from "./models/customVisionOverride";
export {
  getSyncedAvailableModelVision,
  listSyncedAvailableModelVision,
  type SyncedAvailableModelVisionMap,
} from "./models/syncedAvailableModelVision";

// ──────────────── Custom Models ────────────────

function notifyQuotaCombosForProvider(providerId: string): void {
  void (async () => {
    try {
      const { syncQuotaCombosForProvider } = await import("./quotaPools");
      await syncQuotaCombosForProvider(providerId);
    } catch {
      // Non-fatal: quota combo sync errors should not break model operations
    }
  })();
}

function asModelList(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? [...(value as JsonRecord[])] : [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- provider id returns the list, no id returns a record (was an untyped JSON.parse)
export async function getCustomModels(providerId?: string): Promise<any> {
  if (providerId) {
    return asModelList(await readCatalogColumn("custom_models", providerId));
  }
  return getAllCustomModels();
}

export async function getAllCustomModels() {
  const rows = await readAllCatalogColumn("custom_models");
  const result: Record<string, unknown> = {};
  for (const { provider, value } of rows) result[provider] = value;
  return result;
}

export async function addCustomModel(
  providerId: string,
  modelId: string,
  modelName?: string,
  source = "manual",
  apiFormat:
    | "chat-completions"
    | "responses"
    | "embeddings"
    | "rerank"
    | "audio-transcriptions"
    | "audio-speech"
    | "images-generations"
    | "video" = "chat-completions",
  supportedEndpoints: string[] = ["chat"],
  // #2905: optional per-model wire format override (e.g. "claude" for an
  // opencode-go custom model). When unset, routing falls back to the provider
  // default format.
  targetFormat?: string,
  // #1294: optional per-model token limits supplied from the "add custom model"
  // form. Persisted under the same keys the /v1/models catalog reads back.
  tokenLimits: { inputTokenLimit?: number; outputTokenLimit?: number } = {},
  // #1904: optional manual vision-capability override for the "add custom model"
  // form — read back by getCustomVisionCapabilityFields() in the /v1/models catalog.
  supportsVision?: boolean,
  // #9820: optional video-generation job preset (e.g. "agnes-video-job") for
  // custom OpenAI-compatible video models. Persisted on the model row; the
  // /v1/videos/generations handler reads it back to pick the job/poll path.
  generationConfig?: { preset: string },
  isFree?: boolean,
  extraMeta?: {
    dimensions?: number;
    supportedInputTypes?: string[];
    modelType?: "chat" | "embedding" | "image" | "rerank";
    endpointCapabilitySource?: "declared" | "inferred" | "defaulted" | "operator";
  }
) {
  const model = {
    id: modelId,
    name: modelName || modelId,
    source,
    apiFormat,
    supportedEndpoints,
    endpointCapabilitySource:
      extraMeta?.endpointCapabilitySource || (source === "manual" ? "operator" : "defaulted"),
    ...(targetFormat ? { targetFormat } : {}),
    ...(tokenLimits.inputTokenLimit != null
      ? { inputTokenLimit: tokenLimits.inputTokenLimit }
      : {}),
    ...(tokenLimits.outputTokenLimit != null
      ? { outputTokenLimit: tokenLimits.outputTokenLimit }
      : {}),
    ...(typeof supportsVision === "boolean" ? { supportsVision } : {}),
    ...(typeof isFree === "boolean" ? { isFree } : {}),
    ...(generationConfig && generationConfig.preset ? { generationConfig } : {}),
    ...(typeof extraMeta?.dimensions === "number" && extraMeta.dimensions > 0
      ? { dimensions: extraMeta.dimensions }
      : {}),
    ...(Array.isArray(extraMeta?.supportedInputTypes)
      ? { supportedInputTypes: extraMeta.supportedInputTypes }
      : {}),
    ...(typeof extraMeta?.modelType === "string" ? { modelType: extraMeta.modelType } : {}),
  };
  const { created, result } = await updateCatalogColumn("custom_models", providerId, (current) => {
    const models = asModelList(current);
    const exists = models.find((m) => m.id === modelId);
    if (exists) return { skip: true, result: { created: false, result: exists } };
    return { value: [...models, model], result: { created: true, result: model } };
  });
  if (created) {
    finishModelCatalogWriteWithoutBackup();
    notifyQuotaCombosForProvider(providerId);
  }
  return result;
}

/**
 * Replace the entire custom models list for a provider.
 * Preserves per-model compatibility overrides for models that still exist.
 */
type CustomModelReplacement = {
  id: string;
  name?: string;
  source?: string;
  apiFormat?: string;
  supportedEndpoints?: string[];
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  description?: string;
  supportsThinking?: boolean;
  targetFormat?: string;
  generationConfig?: { preset?: string };
  isFree?: boolean;
};

export async function replaceCustomModels(
  providerId: string,
  models: CustomModelReplacement[],
  { allowEmpty = false }: { allowEmpty?: boolean } = {}
) {
  // Guard: skip destructive clear when the caller hasn't explicitly opted in.
  // This prevents callers from wiping manually added models when the
  // upstream /models endpoint fails, times out, or returns an empty list.
  if (models.length === 0 && !allowEmpty) {
    const existing = await getCustomModels(providerId);
    return Array.isArray(existing) ? existing : [];
  }

  // Merge under the row lock so a concurrent edit of the same provider is not lost.
  const merged = await updateCatalogColumn("custom_models", providerId, (current) => {
    const existingMap = new Map<string, JsonRecord>();
    for (const m of asModelList(current)) {
      if (m && typeof m === "object" && m.id) existingMap.set(m.id as string, m);
    }
    const next = mergeCustomModels(models, existingMap);
    return next.length === 0 && current === undefined
      ? { skip: true, result: next }
      : { value: next, result: next };
  });

  finishModelCatalogWriteWithoutBackup();
  notifyQuotaCombosForProvider(providerId);
  return merged;
}

function mergeCustomModels(models: CustomModelReplacement[], existingMap: Map<string, JsonRecord>) {
  // Keep existing per-model compat flags if model still exists
  return models.map((m) => {
    const prev = existingMap.get(m.id);
    // `customModels` is also the user-owned metadata overlay for a same-id
    // synced model. Preserve every defined field instead of maintaining a
    // lossy allowlist here (for example supportsVision and future capabilities).
    const definedModelMetadata = Object.fromEntries(
      Object.entries(m).filter(([, value]) => value !== undefined)
    );
    return {
      ...(prev || {}),
      ...definedModelMetadata,
      id: m.id,
      name: m.name || m.id,
      source: m.source || "auto-sync",
      apiFormat: m.apiFormat || (prev as any)?.apiFormat || "chat-completions",
      supportedEndpoints:
        (prev as any)?.endpointCapabilitySource === "operator"
          ? (prev as any).supportedEndpoints
          : m.supportedEndpoints || (prev as any)?.supportedEndpoints || ["chat"],
      endpointCapabilitySource:
        (prev as any)?.endpointCapabilitySource === "operator"
          ? "operator"
          : (m as any).endpointCapabilitySource ||
            (prev as any)?.endpointCapabilitySource ||
            "defaulted",
      // #2905: preserve a per-model targetFormat override (new value wins, else prev).
      ...(m.targetFormat
        ? { targetFormat: m.targetFormat }
        : (prev as any)?.targetFormat
          ? { targetFormat: (prev as any).targetFormat }
          : {}),
      // #9820: preserve a video job preset across auto-sync (new value wins,
      // else prev — so sync overwrites don't drop a job-config model).
      ...(m.generationConfig?.preset
        ? { generationConfig: { preset: m.generationConfig.preset } }
        : (prev as any)?.generationConfig?.preset
          ? { generationConfig: { preset: (prev as any).generationConfig.preset } }
          : {}),
      // Preserve metadata from provider API (or previous sync)
      ...(m.inputTokenLimit != null
        ? { inputTokenLimit: m.inputTokenLimit }
        : (prev as any)?.inputTokenLimit != null
          ? { inputTokenLimit: (prev as any).inputTokenLimit }
          : {}),
      ...(m.outputTokenLimit != null
        ? { outputTokenLimit: m.outputTokenLimit }
        : (prev as any)?.outputTokenLimit != null
          ? { outputTokenLimit: (prev as any).outputTokenLimit }
          : {}),
      ...(m.description != null
        ? { description: m.description }
        : (prev as any)?.description != null
          ? { description: (prev as any).description }
          : {}),
      ...(m.supportsThinking != null
        ? { supportsThinking: m.supportsThinking }
        : (prev as any)?.supportsThinking != null
          ? { supportsThinking: (prev as any).supportsThinking }
          : {}),
      // Preserve existing compat flags
      ...(prev && (prev as any).normalizeToolCallId !== undefined
        ? { normalizeToolCallId: (prev as any).normalizeToolCallId }
        : {}),
      ...(prev && (prev as any).preserveOpenAIDeveloperRole !== undefined
        ? { preserveOpenAIDeveloperRole: (prev as any).preserveOpenAIDeveloperRole }
        : {}),
      ...(prev && (prev as any).compatByProtocol
        ? { compatByProtocol: (prev as any).compatByProtocol }
        : {}),
      ...(prev && (prev as any).upstreamHeaders
        ? { upstreamHeaders: (prev as any).upstreamHeaders }
        : {}),
    };
  });
}

/**
 * Remove provider-level models created by discovery/import while preserving
 * models the user added manually. Returns the removed model IDs.
 */
export async function deleteImportedCustomModels(providerId: string): Promise<string[]> {
  const removed = await updateCatalogColumn("custom_models", providerId, (current) => {
    const removedModels: JsonRecord[] = [];
    const retained = asModelList(current).filter((model: JsonRecord) => {
      const source =
        typeof model?.source === "string" ? model.source.trim().toLowerCase() : "manual";
      const imported = source === "imported" || source === "api-sync" || source === "auto-sync";
      if (imported) removedModels.push(model);
      return !imported;
    });
    return removedModels.length === 0
      ? { skip: true, result: removedModels }
      : { value: retained, result: removedModels };
  });
  if (removed.length === 0) return [];

  const removedIds = removed.flatMap((model) =>
    typeof model.id === "string" && model.id ? [model.id] : []
  );
  for (const modelId of removedIds) await removeModelCompatOverride(providerId, modelId);
  finishModelCatalogWriteWithoutBackup();
  notifyQuotaCombosForProvider(providerId);
  return removedIds;
}

export async function removeCustomModel(providerId: string, modelId: string) {
  const removed = await updateCatalogColumn("custom_models", providerId, (current) => {
    const models = asModelList(current);
    const filtered = models.filter((m) => m.id !== modelId);
    return filtered.length === models.length
      ? { skip: true, result: false }
      : { value: filtered, result: true };
  });
  if (!removed) return false;

  await removeModelCompatOverride(providerId, modelId);
  finishModelCatalogWriteWithoutBackup();
  notifyQuotaCombosForProvider(providerId);
  return true;
}

// syncedAvailableModels keys are `<providerId>:<connectionId>`.
export async function getSyncedAvailableModelsForConnection(
  providerId: string,
  connectionId: string
): Promise<SyncedAvailableModel[]> {
  const row = await db().queryOne<{ models: unknown }>(
    "SELECT models FROM connection_model_sync WHERE connection_id = $1 AND provider = $2",
    [connectionId, providerId]
  );
  if (!row) return [];
  try {
    return normalizeSyncedAvailableModels(row.models, providerId);
  } catch {
    return [];
  }
}

/** Read only the active selected Antigravity account's fresh catalog, never its siblings. */
export async function getFreshAntigravityModelsForConnection(
  connectionId: string
): Promise<SyncedAvailableModel[]> {
  const row = await db().queryOne<{ provider: string; syncedModelsAt: string | null }>(
    `SELECT provider, synced_models_at AS "syncedModelsAt" FROM provider_connections
     WHERE id = $1 AND is_active AND provider IN ('antigravity', 'agy')`,
    [connectionId]
  );
  if (!row || !isSyncedAtFresh(row.syncedModelsAt)) return [];
  return getSyncedAvailableModelsForConnection(row.provider, connectionId);
}

export async function getSyncedAvailableModels(
  providerId: string
): Promise<SyncedAvailableModel[]> {
  const rows = await db().query<{ models: unknown }>(
    `SELECT models FROM connection_model_sync
     WHERE provider = $1 AND models <> '[]'::jsonb ORDER BY connection_id`,
    [providerId]
  );
  const map = new Map<string, SyncedAvailableModel>();
  for (const row of rows) {
    const models = normalizeSyncedAvailableModels(row.models, providerId);
    for (const m of models) {
      if (m.id) map.set(m.id, m);
    }
  }
  return Array.from(map.values());
}

/** OpenCode and OpenCode Zen synced ids. Excludes opencode-go (`opencode%` would match it). */
export async function readSyncedOpencodeFamilyModelIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  const rows = await db().query<{ models: unknown }>(
    `SELECT models FROM connection_model_sync
     WHERE provider IN ('opencode', 'opencode-zen') AND models <> '[]'::jsonb`
  );
  for (const row of rows) {
    try {
      for (const model of normalizeSyncedAvailableModels(row.models)) {
        if (model.id) ids.add(model.id);
      }
    } catch {
      // A malformed blob must not sink the rest of the catalog.
    }
  }
  return ids;
}

export const SYNCED_AVAILABLE_MODELS_MALFORMED = Symbol("syncedAvailableModelsMalformed");
export type SyncedAvailableModelsByConnection = Record<string, SyncedAvailableModel[]> & {
  [SYNCED_AVAILABLE_MODELS_MALFORMED]?: true;
};

/**
 * Get synced available models for a provider grouped by connection id.
 * A non-enumerable symbol marks malformed persisted rows so strict callers can
 * fail closed without changing the existing Record-shaped API.
 */
export async function getSyncedAvailableModelsByConnection(
  providerId: string
): Promise<SyncedAvailableModelsByConnection> {
  const rows = await db().query<{ connection_id: string; models: unknown }>(
    `SELECT connection_id, models FROM connection_model_sync
     WHERE provider = $1 AND models <> '[]'::jsonb ORDER BY connection_id`,
    [providerId]
  );
  const result: SyncedAvailableModelsByConnection = {};
  for (const row of rows) {
    try {
      if (!Array.isArray(row.models)) throw new Error("synced models are not an array");
      result[row.connection_id] = normalizeSyncedAvailableModels(row.models, providerId);
    } catch {
      Object.defineProperty(result, SYNCED_AVAILABLE_MODELS_MALFORMED, {
        value: true,
        enumerable: false,
      });
    }
  }
  return result;
}

export async function getAllSyncedAvailableModels(): Promise<
  Record<string, SyncedAvailableModel[]>
> {
  const rows = await db().query<{ provider: string; models: unknown }>(
    `SELECT provider, models FROM connection_model_sync
     WHERE models <> '[]'::jsonb ORDER BY provider, connection_id`
  );
  const byProvider = new Map<string, Map<string, SyncedAvailableModel>>();
  for (const row of rows) {
    const providerId = row.provider;
    if (!byProvider.has(providerId)) byProvider.set(providerId, new Map());
    const models = normalizeSyncedAvailableModels(row.models, providerId);
    const map = byProvider.get(providerId)!;
    for (const m of models) {
      if (m.id) map.set(m.id, m);
    }
  }
  const result: Record<string, SyncedAvailableModel[]> = {};
  for (const [providerId, map] of byProvider) {
    result[providerId] = Array.from(map.values());
  }
  return result;
}

/**
 * Find active providers whose synchronized catalog contains an exact model ID.
 *
 * This keeps request-time inference aligned with the same connection-scoped
 * syncedAvailableModels data used by /v1/models without loading every model list
 * into application memory for each request.
 */
export async function getActiveProvidersWithSyncedModel(modelId: string): Promise<string[]> {
  if (!modelId) return [];

  const rows = await db().query<{ provider?: unknown }>(
    `SELECT DISTINCT pc.provider AS provider
     FROM provider_connections pc
     JOIN connection_model_sync cms
       ON cms.connection_id = pc.id AND cms.provider = pc.provider
     CROSS JOIN LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(cms.models) = 'array' THEN cms.models ELSE '[]'::jsonb END
     ) AS synced_model(v)
     WHERE pc.is_active
       AND COALESCE(synced_model.v ->> 'id', synced_model.v ->> 'name', synced_model.v ->> 'model') = $1
     UNION
     SELECT DISTINCT pc.provider AS provider
     FROM provider_connections pc
     JOIN provider_model_catalog pmc ON pmc.provider = pc.provider
     CROSS JOIN LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(pmc.custom_models) = 'array' THEN pmc.custom_models ELSE '[]'::jsonb END
     ) AS custom_model(v)
     WHERE pc.is_active
       AND COALESCE(custom_model.v ->> 'id', custom_model.v ->> 'name', custom_model.v ->> 'model') = $1`,
    [modelId]
  );

  return rows
    .map((row) => row.provider)
    .filter((provider): provider is string => typeof provider === "string" && provider.length > 0)
    .filter((provider) => !isRetiredGitHubCopilotModelId(provider, modelId));
}

/**
 * Replace the model list for a specific connection.
 * Key format: '<providerId>:<connectionId>'
 */
export async function replaceSyncedAvailableModelsForConnection(
  providerId: string,
  connectionId: string,
  models: SyncedAvailableModelInput[]
): Promise<SyncedAvailableModel[]> {
  const key = `${providerId}:${connectionId}`;
  const normalizedModels = normalizeSyncedAvailableModels(models, providerId);
  await persistCanonicalSyncedAvailableModels(
    key,
    normalizedModels,
    normalizeSyncedAvailableModels
  );
  notifyQuotaCombosForProvider(providerId);
  // #12849: stamp the sync time on every successful sync — even a re-sync that
  // returns an unchanged list proves the catalog is still current, so staleness
  // gating in getActiveSyncedCatalog must not treat it as aging regardless.
  if (connectionId) await touchConnectionSyncedModelsAt(connectionId);
  // Return the full unioned list for the provider
  return getSyncedAvailableModels(providerId);
}

/**
 * Remove a single synced available model from all connections of a provider.
 * Returns true if the model was found and removed from at least one connection.
 */
export async function removeSyncedAvailableModel(
  providerId: string,
  modelId: string
): Promise<boolean> {
  const removedAny = await db().transaction(async (tx) => {
    const rows = await tx.query<{ connection_id: string; models: unknown }>(
      `SELECT connection_id, models FROM connection_model_sync
       WHERE provider = $1 AND models <> '[]'::jsonb FOR UPDATE`,
      [providerId]
    );
    let removed = false;
    for (const row of rows) {
      if (!Array.isArray(row.models)) {
        console.warn(
          `[DB] Skipping malformed synced models entry for ${providerId}:${row.connection_id}`
        );
        continue;
      }
      const models = normalizeSyncedAvailableModels(row.models, providerId);
      const filtered = models.filter((m) => m.id !== modelId);
      if (filtered.length !== models.length) {
        removed = true;
        await tx.execute(
          "UPDATE connection_model_sync SET models = $2::jsonb, updated_at = now() WHERE connection_id = $1",
          [row.connection_id, jsonValueParam(filtered)]
        );
      }
    }
    return removed;
  });

  if (removedAny) {
    finishSyncedAvailableModelsWrite();
    notifyQuotaCombosForProvider(providerId);
  }
  return removedAny;
}

export async function deleteSyncedAvailableModelsForConnection(
  providerId: string,
  connectionId: string
): Promise<SyncedAvailableModel[]> {
  const changes = await clearConnectionSyncedModels(providerId, connectionId);
  if (changes > 0) {
    finishSyncedAvailableModelsWrite();
    notifyQuotaCombosForProvider(providerId);
  }
  return getSyncedAvailableModels(providerId);
}

/**
 * Clean model state after a provider connection has been deleted. Imported
 * provider-level models are removed only when no sibling connection remains.
 */
export async function cleanupProviderModelsAfterConnectionDelete(
  providerId: string,
  connectionId: string
): Promise<{
  remainingConnections: number;
  removedImportedModelIds: string[];
  remainingSyncedModels: SyncedAvailableModel[];
}> {
  const remainingSyncedModels = await deleteSyncedAvailableModelsForConnection(
    providerId,
    connectionId
  );
  // The connection delete already cascaded its sync row, so the clear above matched nothing and
  // did not notify: resync the provider's quota combos here regardless.
  notifyQuotaCombosForProvider(providerId);
  const remainingConnections = await getProviderConnectionsCount({ provider: providerId });
  const removedImportedModelIds =
    remainingConnections === 0 ? await deleteImportedCustomModels(providerId) : [];

  return { remainingConnections, removedImportedModelIds, remainingSyncedModels };
}

export async function deleteSyncedAvailableModelsForProvider(providerId: string): Promise<number> {
  const changes = await deleteSyncedAvailableModelsForProviderInternal(providerId);
  if (changes > 0) notifyQuotaCombosForProvider(providerId);
  return changes;
}

/** Prune synced rows whose connection id is not in `allowedConnectionIds`. Returns keys deleted. */
export async function pruneStaleSyncedAvailableModelsForProvider(
  providerId: string,
  allowedConnectionIds: string[]
): Promise<number> {
  if (allowedConnectionIds.length === 0) {
    return deleteSyncedAvailableModelsForProvider(providerId);
  }
  const cleared = await db().query<{ connection_id: string }>(
    `UPDATE connection_model_sync SET models = '[]'::jsonb, updated_at = now()
     WHERE provider = $1 AND models <> '[]'::jsonb AND connection_id <> ALL($2::text[])
     RETURNING connection_id`,
    [providerId, allowedConnectionIds]
  );
  const changes = cleared.length;
  if (changes > 0) {
    await deleteEmptySyncRows(providerId);
    finishSyncedAvailableModelsWrite();
    notifyQuotaCombosForProvider(providerId);
  }
  return changes;
}

/**
 * Apply a tri-state boolean override from `updates` onto `next`:
 * field absent → keep whatever `next` already carries; explicit `null` → clear
 * the override (callers fall back to their heuristic); anything else → persist
 * the coerced boolean.
 */
function applyTriStateBooleanOverride(
  next: JsonRecord,
  updates: Record<string, unknown>,
  field: string
): void {
  if (!Object.prototype.hasOwnProperty.call(updates, field)) return;
  if (updates[field] === null) {
    delete next[field];
    return;
  }
  next[field] = Boolean(updates[field]);
}

export async function updateCustomModel(
  providerId: string,
  modelId: string,
  updates: Record<string, unknown> = {},
  options: { createIfMissing?: boolean } = {}
) {
  const next = await updateCatalogColumn("custom_models", providerId, (currentDoc) => {
    const outcome = applyCustomModelUpdate(asModelList(currentDoc), modelId, updates, options);
    return outcome ? { value: outcome.models, result: outcome.next } : { skip: true, result: null };
  });
  if (next) finishModelCatalogWriteWithoutBackup();
  return next;
}

/** Pure part of `updateCustomModel`: the new list and the updated row, or null for "no such model". */
function applyCustomModelUpdate(
  models: JsonRecord[],
  modelId: string,
  updates: Record<string, unknown>,
  options: { createIfMissing?: boolean }
): { models: JsonRecord[]; next: JsonRecord } | null {
  let index = models.findIndex((m: JsonRecord) => m.id === modelId);

  if (index === -1) {
    if (!options.createIfMissing) return null;
    // A model discovered via sync/passthrough (syncedAvailableModels) has no
    // customModels row until an operator explicitly overrides one of its
    // fields -- PUT /api/provider-models is exactly that "set an override"
    // action, so upsert here (same default shape as addCustomModel()) instead
    // of 404ing on the very save it exists to serve. Observed live: a
    // llama.cpp connection's auto-discovered embedding model had no way to be
    // marked "supports embeddings" because it had never been explicitly
    // imported as a custom model first.
    // Endpoint-only edits are virtual overlays, not manually declared chat
    // models. Do not persist guessed name/apiFormat fields: doing so would
    // overwrite the real synced metadata when catalog rows are merged.
    if (Object.keys(updates).length === 1 && "supportedEndpoints" in updates) {
      models.push({ id: modelId, source: "endpoint-override" });
    } else {
      models.push({
        id: modelId,
        name: modelId,
        source: "manual",
        apiFormat: "chat-completions",
        supportedEndpoints: ["chat"],
      });
    }
    index = models.length - 1;
  }

  const current = models[index];
  const currentCompat = (current as JsonRecord).compatByProtocol as CompatByProtocolMap | undefined;
  let mergedCompat: CompatByProtocolMap | undefined = currentCompat;
  if (
    updates.compatByProtocol !== undefined &&
    typeof updates.compatByProtocol === "object" &&
    updates.compatByProtocol !== null &&
    !Array.isArray(updates.compatByProtocol)
  ) {
    mergedCompat = deepMergeCompatByProtocol(
      currentCompat,
      updates.compatByProtocol as Partial<
        Record<ModelCompatProtocolKey, Partial<ModelCompatPerProtocol>>
      >
    );
    if (!compatByProtocolHasEntries(mergedCompat)) mergedCompat = undefined;
  }

  const next: JsonRecord = {
    ...current,
    ...(updates.modelName !== undefined ? { name: updates.modelName || current.name } : {}),
    ...(updates.apiFormat !== undefined ? { apiFormat: updates.apiFormat } : {}),
    ...(updates.targetFormat !== undefined ? { targetFormat: updates.targetFormat } : {}),
    ...(updates.supportedEndpoints !== undefined
      ? { supportedEndpoints: updates.supportedEndpoints }
      : {}),
    ...(updates.normalizeToolCallId !== undefined
      ? { normalizeToolCallId: Boolean(updates.normalizeToolCallId) }
      : {}),
    ...(updates.isHidden !== undefined ? { isHidden: Boolean(updates.isHidden) } : {}),
  };
  applyTriStateBooleanOverride(next, updates, "preserveOpenAIDeveloperRole");
  // #1904: manual vision-capability override — `null` clears back to the
  // id-based heuristic in getCustomVisionCapabilityFields().
  applyTriStateBooleanOverride(next, updates, "supportsVision");
  applyTriStateBooleanOverride(next, updates, "isFree");
  if (updates.supportedEndpoints !== undefined) {
    next.endpointCapabilitySource = "operator";
  }
  if (updates.compatByProtocol !== undefined) {
    if (mergedCompat && compatByProtocolHasEntries(mergedCompat)) {
      next.compatByProtocol = mergedCompat;
    } else {
      delete next.compatByProtocol;
    }
  }

  if (Object.prototype.hasOwnProperty.call(updates, "upstreamHeaders")) {
    const uh = updates.upstreamHeaders;
    if (uh === null || uh === undefined) {
      delete next.upstreamHeaders;
    } else if (typeof uh === "object" && !Array.isArray(uh)) {
      const s = sanitizeUpstreamHeadersMap(uh as Record<string, unknown>);
      if (Object.keys(s).length === 0) delete next.upstreamHeaders;
      else next.upstreamHeaders = s;
    }
  }

  // #9820: optional video-generation job preset. Mirrors the upstreamHeaders
  // pattern: `null`/`undefined` clears a previously set preset; a well-formed
  // object replaces it verbatim.
  if (Object.prototype.hasOwnProperty.call(updates, "generationConfig")) {
    const gc = updates.generationConfig;
    if (gc === null || gc === undefined) {
      delete next.generationConfig;
    } else if (typeof gc === "object" && !Array.isArray(gc)) {
      next.generationConfig = gc;
    }
  }

  models[index] = next;
  return { models, next };
}

/**
 * Reset ONLY endpoint tags to the latest discovered catalog. This deliberately
 * preserves visibility, aliases, output limits and other operator settings.
 * The row created solely for endpoint editing is removed entirely.
 */
export async function resetModelEndpointOverride(
  providerId: string,
  modelId: string
): Promise<boolean> {
  const discovered = (await getSyncedAvailableModels(providerId)).find((m) => m.id === modelId);
  if (!discovered) return false;

  const reset = await updateCatalogColumn("custom_models", providerId, (current) => {
    const rows = asModelList(current);
    const index = rows.findIndex((row) => row.id === modelId);
    if (index < 0 || rows[index].endpointCapabilitySource !== "operator") {
      return { skip: true, result: false };
    }
    if (rows[index].source === "endpoint-override") {
      rows.splice(index, 1);
    } else {
      rows[index] = {
        ...rows[index],
        supportedEndpoints: discovered.supportedEndpoints || ["chat"],
        endpointCapabilitySource: discovered.endpointCapabilitySource || "defaulted",
      };
    }
    return { value: rows, result: true };
  });
  if (!reset) return false;
  finishModelCatalogWriteWithoutBackup();
  notifyQuotaCombosForProvider(providerId);
  return true;
}

/** Single custom model row of the provider's `custom_models`, or null */
async function getCustomModelRow(providerId: string, modelId: string): Promise<JsonRecord | null> {
  try {
    const models = await readCatalogColumn("custom_models", providerId);
    if (!Array.isArray(models)) return null;
    const isIdMatch = (x: unknown, id: string): boolean => {
      if (!x || typeof x !== "object" || Array.isArray(x)) return false;
      return (x as { id?: string }).id === id;
    };
    // #7364: exact match first; case-insensitive fallback so "glm-4.6V" resolves a
    // custom model saved as "glm-4.6v" (see lookupCustomModelMeta in
    // src/sse/services/model.ts for the sibling lookup this mirrors).
    const m = (models.find((x: unknown) => isIdMatch(x, modelId)) ??
      models.find(
        (x: unknown) =>
          x &&
          typeof x === "object" &&
          !Array.isArray(x) &&
          typeof (x as { id?: string }).id === "string" &&
          ((x as { id: string }).id as string).toLowerCase() === modelId.toLowerCase()
      )) as JsonRecord | undefined;
    return m ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether the given provider/model has "normalize tool call id" (9-char Mistral-style) enabled.
 * Custom model row wins; otherwise {@link getModelCompatOverrides}.
 * When `sourceFormat` is one of `openai` | `openai-responses` | `claude`, per-protocol
 * `compatByProtocol[sourceFormat].normalizeToolCallId` overrides the legacy top-level flag.
 */
export async function getModelNormalizeToolCallId(
  providerId: string,
  modelId: string,
  sourceFormat?: string | null
): Promise<boolean> {
  const m = await getCustomModelRow(providerId, modelId);
  const protocol = sourceFormat && isCompatProtocolKey(sourceFormat) ? sourceFormat : null;

  if (m) {
    if (protocol) {
      const pc = (m.compatByProtocol as CompatByProtocolMap | undefined)?.[protocol];
      if (pc && Object.prototype.hasOwnProperty.call(pc, "normalizeToolCallId")) {
        return Boolean(pc.normalizeToolCallId);
      }
    }
    return Boolean(m.normalizeToolCallId);
  }
  const co = (await readCompatList(providerId)).find((e) => e.id === modelId);
  if (protocol && co?.compatByProtocol?.[protocol]) {
    const pc = co.compatByProtocol[protocol]!;
    if (Object.prototype.hasOwnProperty.call(pc, "normalizeToolCallId")) {
      return Boolean(pc.normalizeToolCallId);
    }
  }
  return Boolean(co?.normalizeToolCallId);
}

/**
 * Explicit preserve-openai-developer preference for this provider/model.
 * `undefined` = unset → routing keeps legacy default (preserve developer for OpenAI format).
 * `false` = map developer → system (e.g. MiniMax). `true` = keep developer.
 * Per-protocol overrides live under `compatByProtocol[sourceFormat]` when `sourceFormat` matches.
 */
export async function getModelPreserveOpenAIDeveloperRole(
  providerId: string,
  modelId: string,
  sourceFormat?: string | null
): Promise<boolean | undefined> {
  const m = await getCustomModelRow(providerId, modelId);
  const protocol = sourceFormat && isCompatProtocolKey(sourceFormat) ? sourceFormat : null;

  if (m) {
    if (protocol) {
      const pc = (m.compatByProtocol as CompatByProtocolMap | undefined)?.[protocol];
      if (pc && Object.prototype.hasOwnProperty.call(pc, "preserveOpenAIDeveloperRole")) {
        return Boolean(pc.preserveOpenAIDeveloperRole);
      }
    }
    if (Object.prototype.hasOwnProperty.call(m, "preserveOpenAIDeveloperRole")) {
      return Boolean(m.preserveOpenAIDeveloperRole);
    }
    return undefined;
  }
  const co = (await readCompatList(providerId)).find((e) => e.id === modelId);
  if (protocol && co?.compatByProtocol?.[protocol]) {
    const pc = co.compatByProtocol[protocol]!;
    if (Object.prototype.hasOwnProperty.call(pc, "preserveOpenAIDeveloperRole")) {
      return Boolean(pc.preserveOpenAIDeveloperRole);
    }
  }
  if (co && Object.prototype.hasOwnProperty.call(co, "preserveOpenAIDeveloperRole")) {
    return Boolean(co.preserveOpenAIDeveloperRole);
  }
  return undefined;
}

/**
 * Check if the model is flagged as hidden from the public catalog.
 * `modality` (default "chat") scopes the check to one endpoint/registry — see
 * {@link isOverrideHiddenForModality} — so an identically-ID'd model in a different
 * modality's registry (e.g. Chat vs Image, #12172) is not silently suppressed too.
 */
export async function getModelIsHidden(
  providerId: string,
  modelId: string,
  modality: string = "chat"
): Promise<boolean> {
  const m = await getCustomModelRow(providerId, modelId);
  if (m && Object.prototype.hasOwnProperty.call(m, "isHidden")) {
    return Boolean(m.isHidden);
  }
  const co = (await readCompatList(providerId)).find((e) => e.id === modelId);
  return isOverrideHiddenForModality(co, modality);
}

/**
 * Get a map of provider ID → set of hidden model IDs from all modelCompatOverrides
 * and customModels, scoped to one `modality` (default "chat", matching every
 * pre-#12172 caller's original chat-only intent). Used by auto-combo candidate
 * building to skip user-hidden models. Single bulk DB query — not N+1 per model.
 */
export async function getHiddenModelsByProvider(
  modality: string = "chat"
): Promise<Map<string, Set<string>>> {
  const visibilityByProvider = new Map<string, Map<string, boolean>>();
  // Compat overrides first, custom models second: a custom row wins over a compat one.
  const rows = [
    ...(await readAllCatalogColumn("compat_overrides")).map(({ provider, value }) => ({
      namespace: "modelCompatOverrides",
      key: provider,
      value,
    })),
    ...(await readAllCatalogColumn("custom_models")).map(({ provider, value }) => ({
      namespace: "customModels",
      key: provider,
      value,
    })),
  ];

  for (const namespace of ["modelCompatOverrides", "customModels"]) {
    for (const row of rows) {
      if (row.namespace !== namespace || !row.value) continue;
      try {
        const parsed = row.value;
        if (!Array.isArray(parsed)) continue;
        for (const entry of parsed) {
          if (!entry || typeof entry !== "object") continue;
          const modelId = (entry as { id?: unknown }).id;
          if (typeof modelId !== "string" || modelId.length === 0) continue;
          const record = entry as { isHidden?: unknown; hiddenModalities?: unknown };
          const hasHiddenInfo =
            Object.prototype.hasOwnProperty.call(record, "isHidden") ||
            (namespace === "modelCompatOverrides" &&
              record.hiddenModalities &&
              typeof record.hiddenModalities === "object");
          if (!hasHiddenInfo) continue;
          // #12172: customModels rows have no modality scope (single user-managed
          // entry) — legacy global isHidden applies to every modality unchanged.
          const isHidden =
            namespace === "modelCompatOverrides"
              ? isOverrideHiddenForModality(
                  {
                    isHidden: Boolean(record.isHidden),
                    hiddenModalities: record.hiddenModalities as
                      Record<string, boolean> | undefined,
                  },
                  modality
                )
              : Boolean(record.isHidden);
          let visibility = visibilityByProvider.get(row.key);
          if (!visibility) {
            visibility = new Map<string, boolean>();
            visibilityByProvider.set(row.key, visibility);
          }
          visibility.set(modelId, isHidden);
        }
      } catch {
        // Skip malformed entries
      }
    }
  }

  return new Map(
    [...visibilityByProvider].flatMap(([providerId, visibility]) => {
      const hiddenModels = [...visibility].flatMap(([modelId, isHidden]) =>
        isHidden ? [modelId] : []
      );
      return hiddenModels.length > 0 ? [[providerId, new Set(hiddenModels)] as const] : [];
    })
  );
}

/**
 * Persist the hidden flag for a model. Stores the override on the custom-model
 * row when one exists, otherwise on the compat-override list. Setting
 * `hidden = false` is a no-op when the model is already visible.
 */
export async function setModelIsHidden(
  providerId: string,
  modelId: string,
  hidden: boolean,
  modality?: string
): Promise<void> {
  const customRow = await getCustomModelRow(providerId, modelId);
  if (customRow) {
    if (hidden) {
      await updateCustomModel(providerId, modelId, { isHidden: true });
    } else if (Object.prototype.hasOwnProperty.call(customRow, "isHidden")) {
      await updateCustomModel(providerId, modelId, { isHidden: false });
    }
    return;
  }

  // #12172: a modality-scoped write never touches the legacy all-modalities
  // `isHidden` flag — it only sets/clears that one modality's override, so an
  // identically-ID'd model in a different modality's registry is unaffected.
  if (modality) {
    await mergeModelCompatOverride(providerId, modelId, { isHidden: hidden, modality });
    return;
  }

  await updateCompatList(providerId, (list) => {
    const idx = list.findIndex((e) => e.id === modelId);
    if (hidden) {
      const prev = idx >= 0 ? list[idx] : { id: modelId };
      const next: ModelCompatOverride = { ...prev, id: modelId, isHidden: true };
      if (idx >= 0) list[idx] = next;
      else list.push(next);
      return list;
    }

    if (idx < 0) return null;
    if (Object.keys(list[idx]).length <= 1) {
      // Only `id` left; drop the entry entirely.
      return list.filter((_, i) => i !== idx);
    }
    delete list[idx].isHidden;
    return list;
  });
}

function readUpstreamFromJsonRecord(
  row: JsonRecord | null | undefined,
  key: "upstreamHeaders"
): Record<string, string> | undefined {
  if (!row) return undefined;
  const raw = row[key];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const s = sanitizeUpstreamHeadersMap(raw as Record<string, unknown>);
  return Object.keys(s).length > 0 ? s : undefined;
}

/**
 * Extra HTTP headers to send to the upstream provider for this model (after executor auth headers).
 * Order: top-level `upstreamHeaders` on the custom model row (override list merged under custom),
 * then per-protocol `compatByProtocol[sourceFormat].upstreamHeaders` (wins on key conflict).
 * Use for gateways that expect `Authentication`, `X-API-Key`, etc. alongside Bearer.
 *
 * `modelId` should be the **canonical** model id when known. Callers that accept client aliases
 * (e.g. chat proxy) should merge results for both alias and `resolveModelAlias(alias)` so UI
 * config on the resolved id still applies — see `chatCore` merge.
 */
export async function getModelUpstreamExtraHeaders(
  providerId: string,
  modelId: string,
  sourceFormat?: string | null
): Promise<Record<string, string>> {
  const protocol = sourceFormat && isCompatProtocolKey(sourceFormat) ? sourceFormat : null;
  const m = await getCustomModelRow(providerId, modelId);

  const base: Record<string, string> = {};
  if (m) {
    const fromModel = readUpstreamFromJsonRecord(m, "upstreamHeaders");
    if (fromModel) Object.assign(base, fromModel);
    if (protocol) {
      const pc = (m.compatByProtocol as CompatByProtocolMap | undefined)?.[protocol];
      const fromProto = pc?.upstreamHeaders;
      if (fromProto && typeof fromProto === "object") {
        Object.assign(base, sanitizeUpstreamHeadersMap(fromProto as Record<string, unknown>));
      }
    }
    return base;
  }

  const co = (await readCompatList(providerId)).find((e) => e.id === modelId);
  if (co?.upstreamHeaders) {
    Object.assign(base, sanitizeUpstreamHeadersMap(co.upstreamHeaders as Record<string, unknown>));
  }
  if (protocol && co?.compatByProtocol?.[protocol]?.upstreamHeaders) {
    Object.assign(
      base,
      sanitizeUpstreamHeadersMap(
        co.compatByProtocol[protocol]!.upstreamHeaders as Record<string, unknown>
      )
    );
  }
  return base;
}
