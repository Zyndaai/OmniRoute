/**
 * Explicit Custom Models "Vision capable" lookup.
 *
 * Dashboard stores the flag under the connection id (often an
 * openai-compatible-chat-* uuid) and the path-shaped model id. Clients send
 * the advertised alias (`vllm/path/...`), the bare path, or the internal
 * `providerId/modelPath`. parseModel splits on the first slash, so the
 * advertised forms miss the stored pair. Match the stored row against all
 * three forms before Vision Bridge substitutes a fallback VLM.
 */
import { readAllCatalogColumn, readCatalogColumn } from "./catalogRow";

/** Nested provider → model map of explicit custom-model vision overrides. */
export type CustomModelVisionOverrideMap = ReadonlyMap<string, ReadonlyMap<string, boolean>>;

export interface CustomModelVisionOverrideReadOptions {
  /**
   * Raw model string from the request (`vllm/orcarouter/Qwen...`, the bare
   * path, or `providerId/modelPath`). Used when the parsed provider/model pair
   * does not match the stored customModels key.
   */
  lookupKey?: string;
}

type OverrideHit = { providerId: string; modelId: string; supportsVision: boolean };

function idsEqual(left: string, right: string): boolean {
  return left === right || left.toLowerCase() === right.toLowerCase();
}

function isPathShaped(value: string | undefined): boolean {
  return Boolean(value && value.includes("/"));
}

/** Stored custom-model id matches the parsed pair and/or the raw request string. */
export function customModelIdMatchesRequest(
  storedId: string,
  requestedModelId: string,
  lookupKey?: string
): boolean {
  if (!storedId) return false;
  if (idsEqual(storedId, requestedModelId)) return true;
  if (lookupKey && idsEqual(storedId, lookupKey)) return true;
  // Suffix only when the stored id is itself path-shaped. A leaf like "4o"
  // must not match lookupKey "openai/gpt-4o".
  if (
    isPathShaped(storedId) &&
    lookupKey &&
    lookupKey.toLowerCase().endsWith(`/${storedId.toLowerCase()}`)
  ) {
    return true;
  }
  return false;
}

function readVisionOverrideFromModels(models: unknown, modelId: string): boolean | null {
  if (!models) return null;
  try {
    if (!Array.isArray(models)) return null;
    const entry = models.find(
      (candidate): candidate is { id: string; supportsVision?: boolean } =>
        candidate !== null &&
        typeof candidate === "object" &&
        !Array.isArray(candidate) &&
        typeof (candidate as { id?: unknown }).id === "string" &&
        idsEqual((candidate as { id: string }).id, modelId)
    );
    return entry && typeof entry.supportsVision === "boolean" ? entry.supportsVision : null;
  } catch {
    return null;
  }
}

/**
 * Read only this provider's exact custom-model id, without the broader
 * path-shaped fallback that can match an identically named model in another
 * node. Vision Bridge uses this when a slash-bearing id may be either a
 * foreign routing prefix or an upstream vendor namespace (#16801).
 *
 * null means no owned explicit evidence, not a non-vision verdict.
 */
export async function getExactCustomModelVisionOverride(
  providerId: string,
  modelId: string
): Promise<boolean | null> {
  if (!providerId || !modelId) return null;
  try {
    return readVisionOverrideFromModels(
      await readCatalogColumn("custom_models", providerId),
      modelId
    );
  } catch {
    return null;
  }
}

function collectOverrideHits(map: CustomModelVisionOverrideMap): OverrideHit[] {
  const hits: OverrideHit[] = [];
  for (const [providerId, byModel] of map) {
    for (const [modelId, supportsVision] of byModel) {
      hits.push({ providerId, modelId, supportsVision });
    }
  }
  return hits;
}

function pickMatchingOverride(
  hits: OverrideHit[],
  providerId: string,
  modelId: string,
  lookupKey?: string
): boolean | null {
  const exact = hits.find(
    (hit) => idsEqual(hit.providerId, providerId) && idsEqual(hit.modelId, modelId)
  );
  if (exact) return exact.supportsVision;

  const matches = hits.filter((hit) =>
    customModelIdMatchesRequest(hit.modelId, modelId, lookupKey)
  );
  if (matches.length === 0) return null;
  const first = matches[0].supportsVision;
  if (!matches.every((hit) => hit.supportsVision === first)) return null;
  if (providerId) {
    const sameProvider = matches.filter((hit) => idsEqual(hit.providerId, providerId));
    if (sameProvider.length === 1) return sameProvider[0].supportsVision;
  }
  return first;
}

/**
 * Resolve one explicit custom-model vision override. A supplied bulk map avoids
 * database reads for request/build-local capability resolution.
 */
export async function getCustomModelVisionOverride(
  providerId: string,
  modelId: string,
  bulk?: CustomModelVisionOverrideMap | null,
  options: CustomModelVisionOverrideReadOptions = {}
): Promise<boolean | null> {
  try {
    const lookupKey = options.lookupKey;
    const canScan = isPathShaped(modelId) || isPathShaped(lookupKey);
    if (!providerId && !canScan) return null;

    if (bulk) {
      if (!canScan && providerId) {
        return bulk.get(providerId)?.get(modelId) ?? null;
      }
      return pickMatchingOverride(collectOverrideHits(bulk), providerId, modelId, lookupKey);
    }
    if (providerId) {
      const exact = readVisionOverrideFromModels(
        await readCatalogColumn("custom_models", providerId),
        modelId
      );
      if (exact !== null) return exact;
    }
    if (!canScan) return null;
    return pickMatchingOverride(
      collectOverrideHits(await listCustomModelVisionOverrides()),
      providerId,
      modelId,
      lookupKey
    );
  } catch {
    return null;
  }
}

/** Provider → parsed `customModels` rows, the shape `getCustomModels()` returns without a provider. */
export type CustomModelsByProvider = Readonly<Record<string, unknown>>;

/**
 * Bulk-load every provider's custom models with one query.
 *
 * One request-level snapshot shares this single read between the vision
 * overrides and the #16929 operator endpoint overlay of the live listing, so
 * `/api/models` never re-reads the table per consumer. A failing read yields an
 * empty map (fail open).
 */
export async function readCustomModelsByProvider(): Promise<CustomModelsByProvider> {
  try {
    const rows = await readAllCatalogColumn("custom_models");
    const result: Record<string, unknown> = {};
    for (const { provider, value } of rows) result[provider] = value;
    return result;
  } catch {
    return {};
  }
}

/** Derive the explicit custom-model vision overrides from already-read `customModels` rows. */
export function buildCustomModelVisionOverrides(
  customModelsByProvider: CustomModelsByProvider
): CustomModelVisionOverrideMap {
  const result = new Map<string, Map<string, boolean>>();
  for (const [key, models] of Object.entries(customModelsByProvider)) {
    if (!Array.isArray(models)) continue;
    const byModel = new Map<string, boolean>();
    for (const candidate of models) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const { id, supportsVision } = candidate as {
        id?: unknown;
        supportsVision?: unknown;
      };
      if (typeof id === "string" && typeof supportsVision === "boolean") {
        byModel.set(id, supportsVision);
      }
    }
    if (byModel.size > 0) result.set(key, byModel);
  }
  return result;
}

/** Bulk-load explicit custom-model vision overrides with one query. */
export async function listCustomModelVisionOverrides(): Promise<CustomModelVisionOverrideMap> {
  return buildCustomModelVisionOverrides(await readCustomModelsByProvider());
}
