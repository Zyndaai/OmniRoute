import {
  parseReasoningEffortsOverride,
  REASONING_EFFORT_OVERRIDE_VALUES,
  type ReasoningEffortOverrideValue,
} from "@/shared/reasoning/reasoningEffortsOverride";
import { db, jsonb } from "./pg";
import { invalidateDbCache, loadModelMetadataSnapshot } from "./readCache";

export type NumericModelCapabilityOverrideKey =
  "max_input_tokens" | "max_output_tokens" | "max_token";
export type ModelCapabilityOverrideKey = NumericModelCapabilityOverrideKey | "reasoning_efforts";

interface ModelCapabilityOverrideBase {
  provider: string;
  modelId: string;
  target: string;
  refreshedAt: string;
}

export type ModelCapabilityOverride =
  | (ModelCapabilityOverrideBase & {
      key: NumericModelCapabilityOverrideKey;
      value: number;
    })
  | (ModelCapabilityOverrideBase & {
      key: "reasoning_efforts";
      value: ReasoningEffortOverrideValue[];
    });

interface OverrideRow {
  provider: string;
  model_id: string;
  override_key: string;
  override_value: unknown;
  refreshed_at: string;
}

function isNumericKey(value: unknown): value is NumericModelCapabilityOverrideKey {
  return value === "max_input_tokens" || value === "max_output_tokens" || value === "max_token";
}

function isSupportedKey(value: unknown): value is ModelCapabilityOverrideKey {
  return isNumericKey(value) || value === "reasoning_efforts";
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isReasoningEfforts(value: unknown): value is ReasoningEffortOverrideValue[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const allowed = new Set<string>(REASONING_EFFORT_OVERRIDE_VALUES);
  return (
    value.every((entry) => typeof entry === "string" && allowed.has(entry)) &&
    new Set(value).size === value.length
  );
}

export function parseModelOverrideTarget(
  target: unknown
): { provider: string; modelId: string } | null {
  const raw = typeof target === "string" ? target.trim() : "";
  const slashIndex = raw.indexOf("/");
  if (slashIndex <= 0 || slashIndex === raw.length - 1) return null;

  const provider = raw.slice(0, slashIndex).trim();
  const modelId = raw.slice(slashIndex + 1).trim();
  if (!provider || !modelId) return null;
  return { provider, modelId };
}

function toOverride(row: OverrideRow): ModelCapabilityOverride | null {
  if (!isSupportedKey(row.override_key)) return null;

  const parsedValue = row.override_value;

  const base: ModelCapabilityOverrideBase = {
    provider: row.provider,
    modelId: row.model_id,
    target: `${row.provider}/${row.model_id}`,
    refreshedAt: row.refreshed_at,
  };
  if (row.override_key === "reasoning_efforts") {
    return isReasoningEfforts(parsedValue)
      ? { ...base, key: row.override_key, value: parsedValue }
      : null;
  }
  return isPositiveInteger(parsedValue)
    ? { ...base, key: row.override_key, value: parsedValue }
    : null;
}

/** Nested provider → model → numeric override map used by build-local snapshots. */
export type NestedMaxTokenOverrideMap = ReadonlyMap<string, ReadonlyMap<string, number>>;

const overrideKey = (provider: string, modelId: string, key: string) =>
  `${provider}\u0000${modelId}\u0000${key}`;

/**
 * Every override, keyed by provider/model/key, shared until a model-metadata write or the
 * snapshot TTL (see loadModelMetadataSnapshot). Invalid rows are dropped here once.
 */
function overrideSnapshot(): Promise<Map<string, ModelCapabilityOverride>> {
  return loadModelMetadataSnapshot("model_capability_overrides", async () => {
    const rows = await db().query<OverrideRow>(
      "SELECT provider, model_id, override_key, override_value, refreshed_at " +
        "FROM model_capability_overrides"
    );
    const byKey = new Map<string, ModelCapabilityOverride>();
    for (const row of rows) {
      const override = toOverride(row);
      if (override) byKey.set(overrideKey(row.provider, row.model_id, row.override_key), override);
    }
    return byKey;
  });
}

export async function getModelCapabilityOverride(
  provider: string | null | undefined,
  modelId: string | null | undefined,
  key: NumericModelCapabilityOverrideKey,
  bulkMaxTokenOverrides?: NestedMaxTokenOverrideMap | null
): Promise<number | null> {
  const target = parseModelOverrideTarget(`${provider || ""}/${modelId || ""}`);
  if (!target || !isNumericKey(key)) return null;

  if (bulkMaxTokenOverrides) {
    // The caller pairs the bulk map with the key it was built for
    // (max_output_tokens or max_input_tokens in the #9199 snapshot).
    return bulkMaxTokenOverrides.get(target.provider)?.get(target.modelId) ?? null;
  }

  try {
    const override = (await overrideSnapshot()).get(
      overrideKey(target.provider, target.modelId, key)
    );
    return override && override.key !== "reasoning_efforts" ? override.value : null;
  } catch {
    return null;
  }
}

export async function getReasoningEffortsOverride(
  provider: string | null | undefined,
  modelId: string | null | undefined,
  bulk?: ReadonlyMap<string, ReadonlyMap<string, readonly ReasoningEffortOverrideValue[]>> | null
): Promise<readonly ReasoningEffortOverrideValue[] | null> {
  const target = parseModelOverrideTarget(`${provider || ""}/${modelId || ""}`);
  if (!target) return null;
  if (bulk) return bulk.get(target.provider)?.get(target.modelId) ?? null;

  try {
    const override = (await overrideSnapshot()).get(
      overrideKey(target.provider, target.modelId, "reasoning_efforts")
    );
    return override?.key === "reasoning_efforts" ? [...override.value] : null;
  } catch {
    return null;
  }
}

export async function setModelCapabilityOverride(
  target: string,
  key: ModelCapabilityOverrideKey,
  value: number | string | readonly string[]
): Promise<boolean> {
  const parsedTarget = parseModelOverrideTarget(target);
  if (!parsedTarget || !isSupportedKey(key)) return false;

  let normalizedValue: number | ReasoningEffortOverrideValue[];
  if (key === "reasoning_efforts") {
    const parsed = Array.isArray(value)
      ? parseReasoningEffortsOverride(value.join(","))
      : parseReasoningEffortsOverride(value);
    if (!parsed.ok) return false;
    normalizedValue = parsed.efforts;
  } else {
    if (!isPositiveInteger(value)) return false;
    normalizedValue = value;
  }

  await db().execute(
    `INSERT INTO model_capability_overrides (provider, model_id, override_key, override_value, refreshed_at)
     VALUES ($1, $2, $3, $4::jsonb, now())
     ON CONFLICT (provider, model_id, override_key)
     DO UPDATE SET override_value = EXCLUDED.override_value, refreshed_at = EXCLUDED.refreshed_at`,
    [parsedTarget.provider, parsedTarget.modelId, key, jsonb(normalizedValue)]
  );
  invalidateDbCache("model-capabilities");
  return true;
}

export async function removeModelCapabilityOverride(
  target: string,
  key: ModelCapabilityOverrideKey
): Promise<boolean> {
  const parsedTarget = parseModelOverrideTarget(target);
  if (!parsedTarget || !isSupportedKey(key)) return false;

  const info = await db().execute(
    "DELETE FROM model_capability_overrides " +
      "WHERE provider = $1 AND model_id = $2 AND override_key = $3",
    [parsedTarget.provider, parsedTarget.modelId, key]
  );
  if (info.changes > 0) invalidateDbCache("model-capabilities");
  return info.changes > 0;
}

export async function listModelCapabilityOverrides(): Promise<ModelCapabilityOverride[]> {
  try {
    const rows = await db().query<OverrideRow>(
      "SELECT provider, model_id, override_key, override_value, refreshed_at " +
        "FROM model_capability_overrides ORDER BY refreshed_at DESC"
    );
    return rows.map(toOverride).filter((entry): entry is ModelCapabilityOverride => entry !== null);
  } catch {
    return [];
  }
}
