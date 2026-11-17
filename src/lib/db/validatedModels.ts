import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { db, jsonb, type DbExecutor } from "./pg";
import { isExclusiveConnectionActivelyLeased } from "./exclusiveConnectionLeases";
import { finishModelCatalogWriteWithoutBackup } from "./models/modelCatalogWriteSignals";
import { ModelValidationError, type ValidationInput } from "../modelValidation/http";

interface ConnectionRow {
  id: string;
  provider: string;
  is_active: boolean;
  rate_limited_until?: string | null;
  test_status?: string | null;
  expires_at?: string | null;
  provider_specific_data?: unknown;
  [field: string]: unknown;
}
export interface ValidationSnapshot {
  readonly provider: string;
  readonly modelId: string;
  readonly connectionId: string;
  readonly startedAt: number;
  /** Internal only. Never serialize this credential/configuration fingerprint. */
  readonly fingerprint: string;
}

const VOLATILE_FIELDS = new Set([
  "updated_at",
  "last_used_at",
  "last_selected_at",
  "sticky_use_count",
  "synced_models_at",
]);

function unavailable(): never {
  throw new ModelValidationError(
    409,
    "VALIDATION_CONNECTION_UNAVAILABLE",
    "Selected connection is unavailable or its configuration changed"
  );
}

function assertConnectionAvailable(
  connection: ConnectionRow | undefined,
  input: Pick<ValidationInput, "provider" | "connectionId">,
  leased: boolean
): asserts connection is ConnectionRow {
  if (!connection || connection.provider !== input.provider || connection.is_active !== true)
    unavailable();
  if (connection.rate_limited_until && Date.parse(connection.rate_limited_until) > Date.now())
    unavailable();
  if (["banned", "expired", "credits_exhausted", "invalid"].includes(connection.test_status ?? ""))
    unavailable();
  if (leased) unavailable();
  const raw = connection.provider_specific_data;
  const data: Record<string, unknown> =
    typeof raw === "string" ? JSON.parse(raw) : raw && typeof raw === "object" ? (raw as never) : {};
  if (data.cliproxyapiMode === "claude-native" || data.darioMode === "claude-native") unavailable();
}

/**
 * Reads the configuration the fingerprint covers. Inside the commit transaction pass `tx`,
 * so every read sees the same locked state; `leased` is resolved by the caller because the
 * lease check runs on its own connection.
 */
async function readState(
  input: Pick<ValidationInput, "provider" | "connectionId" | "modelId">,
  ex: DbExecutor,
  leased: boolean
) {
  const connection = await ex.queryOne<ConnectionRow>(
    "SELECT * FROM provider_connections WHERE id = $1",
    [input.connectionId]
  );
  assertConnectionAvailable(connection, input, leased);
  const proxy = await ex.queryOne<Record<string, unknown>>(
    "SELECT * FROM upstream_proxy_config WHERE provider_id = $1",
    [input.provider]
  );
  if (proxy?.enabled && proxy.mode !== "native") unavailable();
  const stableConnection = Object.fromEntries(
    Object.entries(connection).filter(([key]) => !VOLATILE_FIELDS.has(key))
  );
  // Legacy compatible connections can reference a node type, not its concrete id.
  const nodes = await ex.query("SELECT * FROM provider_nodes ORDER BY id");
  const plugins = await ex.query("SELECT * FROM plugins ORDER BY id");
  const settings = await ex.query(
    "SELECT namespace, key, value FROM config_entries WHERE namespace IN ('settings', 'proxyConfig') ORDER BY namespace, key"
  );
  const modelRow = await ex.queryOne<{ custom_models: unknown }>(
    "SELECT custom_models FROM provider_model_catalog WHERE provider = $1",
    [input.provider]
  );
  const models = (modelRow?.custom_models ?? []) as Array<Record<string, unknown>>;
  if (!Array.isArray(models)) unavailable();
  if (models.some((model) => model.id === input.modelId)) {
    throw new ModelValidationError(
      409,
      "VALIDATION_MODEL_EXISTS",
      "Custom model already exists; validation does not overwrite models"
    );
  }
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ stableConnection, nodes, settings, proxy, plugins }))
    .digest("hex");
  return { fingerprint, models };
}

export async function createValidationSnapshot(input: ValidationInput): Promise<ValidationSnapshot> {
  const leased = await isExclusiveConnectionActivelyLeased(input.connectionId);
  return {
    provider: input.provider,
    modelId: input.modelId,
    connectionId: input.connectionId,
    startedAt: Date.now(),
    fingerprint: (await readState(input, db(), leased)).fingerprint,
  };
}

async function assertSnapshotOn(
  snapshot: ValidationSnapshot,
  ex: DbExecutor,
  leased: boolean
): Promise<void> {
  if (
    Date.now() - snapshot.startedAt > 90_000 ||
    (await readState(snapshot, ex, leased)).fingerprint !== snapshot.fingerprint
  )
    unavailable();
}

export async function assertValidationSnapshot(snapshot: ValidationSnapshot): Promise<void> {
  const leased = await isExclusiveConnectionActivelyLeased(snapshot.connectionId);
  await assertSnapshotOn(snapshot, db(), leased);
}

/**
 * Compare configuration, insert, and read back in one transaction. The provider's catalog
 * row is locked first, so two validations of the same provider serialize and a concurrent
 * custom-model edit cannot be lost.
 */
export async function commitValidatedModel(
  snapshot: ValidationSnapshot,
  input: ValidationInput,
  validation: Record<string, unknown>
) {
  if (
    input.provider !== snapshot.provider ||
    input.modelId !== snapshot.modelId ||
    input.connectionId !== snapshot.connectionId
  )
    unavailable();
  const model = {
    id: input.modelId,
    name: input.modelName ?? input.modelId,
    source: "manual",
    apiFormat: input.apiFormat,
    supportedEndpoints: ["chat"],
    ...(input.max_input_tokens === undefined ? {} : { inputTokenLimit: input.max_input_tokens }),
    ...(input.max_output_tokens === undefined ? {} : { outputTokenLimit: input.max_output_tokens }),
    validation,
  };
  const leased = await isExclusiveConnectionActivelyLeased(input.connectionId);
  await db().transaction(async (tx) => {
    await tx.execute(
      "INSERT INTO provider_model_catalog (provider) VALUES ($1) ON CONFLICT (provider) DO NOTHING",
      [input.provider]
    );
    await tx.queryOne(
      "SELECT provider FROM provider_model_catalog WHERE provider = $1 FOR UPDATE",
      [input.provider]
    );
    await assertSnapshotOn(snapshot, tx, leased);
    const { models } = await readState(input, tx, leased);
    await tx.execute(
      "UPDATE provider_model_catalog SET custom_models = $2::jsonb, updated_at = now() WHERE provider = $1",
      [input.provider, jsonb([...models, model])]
    );
    const row = await tx.queryOne<{ custom_models: unknown }>(
      "SELECT custom_models FROM provider_model_catalog WHERE provider = $1",
      [input.provider]
    );
    const saved = (row?.custom_models as Array<Record<string, unknown>> | undefined)?.find(
      (item) => item.id === input.modelId
    );
    // jsonb does not keep key order, so compare structurally against the JSON round trip.
    if (!isDeepStrictEqual(saved, JSON.parse(JSON.stringify(model))))
      throw new Error("Validated model readback failed");
  });
  finishModelCatalogWriteWithoutBackup();
  return model;
}
