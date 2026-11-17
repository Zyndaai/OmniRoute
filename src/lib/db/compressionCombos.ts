import { v4 as uuidv4 } from "uuid";
import type {
  CompressionEngineId,
  CompressionPipelineStep,
} from "@omniroute/open-sse/services/compression/types.ts";
import type { OutputStyleSelectionEntry } from "@omniroute/open-sse/services/compression/outputStyles/apply.ts";

import { db, jsonb, ts, type DbExecutor } from "./pg";

export interface CompressionCombo {
  id: string;
  name: string;
  description: string;
  pipeline: CompressionPipelineStep[];
  languagePacks: string[];
  outputMode: boolean;
  outputModeIntensity: string;
  outputStyles: OutputStyleSelectionEntry[];
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

/** `id` is the routing combo id: the assignment's primary key (there is no surrogate id). */
export interface CompressionComboAssignment {
  id: string;
  compressionComboId: string;
  routingComboId: string;
  createdAt: string;
}

type Row = Record<string, unknown>;

const DEFAULT_COMPRESSION_COMBO_ID = "default-caveman";
const DEFAULT_COMPRESSION_COMBO_NAME = "Standard Savings";
const DEFAULT_COMPRESSION_COMBO_DESCRIPTION = "Default lossless dedup and whitespace compression";
const LEGACY_RTK_CAVEMAN_DESCRIPTION = "Default RTK + Caveman compression pipeline";
const LEGACY_DEFAULT_COMPRESSION_COMBO_DESCRIPTION = "Default Caveman compression pipeline";

function defaultCompressionComboPipeline(): CompressionPipelineStep[] {
  return [{ engine: "session-dedup" }, { engine: "lite" }];
}

function isPreviousLossySeedPipeline(pipeline: CompressionPipelineStep[]): boolean {
  return (
    pipeline.length === 2 &&
    pipeline[0]?.engine === "rtk" &&
    pipeline[0]?.intensity === "standard" &&
    pipeline[1]?.engine === "caveman" &&
    pipeline[1]?.intensity === "full"
  );
}

function parseJsonArray<T>(value: unknown, fallback: T[]): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== "string") return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
}

// Keep in sync with stackedPipelineStepSchema + ENGINE_CATALOG (#6747).
const KNOWN_ENGINE_IDS = [
  "lite",
  "caveman",
  "aggressive",
  "ultra",
  "rtk",
  "headroom",
  "session-dedup",
  "ccr",
  "relevance",
  "codex-responses",
];

function normalizePipeline(value: unknown): CompressionPipelineStep[] {
  return parseJsonArray<CompressionPipelineStep>(value, []).filter((step) => {
    return step && typeof step === "object" && KNOWN_ENGINE_IDS.includes(String(step.engine));
  });
}

function normalizeLanguagePacks(value: unknown): string[] {
  const packs = parseJsonArray<string>(value, ["en"]).filter(
    (pack): pack is string => typeof pack === "string" && pack.trim().length > 0
  );
  return [...new Set(packs.length > 0 ? packs.map((pack) => pack.trim()) : ["en"])];
}

function normalizeOutputStyles(value: unknown): OutputStyleSelectionEntry[] {
  return parseJsonArray<OutputStyleSelectionEntry>(value, []).filter(
    (entry): entry is OutputStyleSelectionEntry =>
      Boolean(entry) &&
      typeof entry === "object" &&
      typeof entry.id === "string" &&
      entry.id.trim().length > 0 &&
      ["lite", "full", "ultra"].includes(entry.level)
  );
}

function isLegacySeededDefaultPipeline(pipeline: CompressionPipelineStep[]): boolean {
  if (pipeline.length !== 1) return false;
  const [step] = pipeline;
  return step.engine === "caveman" && (step.intensity === undefined || step.intensity === "full");
}

async function upgradeLegacySeededDefaultCompressionCombo(): Promise<void> {
  const row = await db().queryOne<{ name?: string; description?: string; pipeline?: unknown }>(
    "SELECT name, description, pipeline FROM compression_combos WHERE id = $1",
    [DEFAULT_COMPRESSION_COMBO_ID]
  );

  if (!row) return;

  const description = String(row.description ?? "");
  const isSeededMetadata =
    String(row.name ?? "") === DEFAULT_COMPRESSION_COMBO_NAME &&
    (description === LEGACY_DEFAULT_COMPRESSION_COMBO_DESCRIPTION ||
      description === LEGACY_RTK_CAVEMAN_DESCRIPTION ||
      description === DEFAULT_COMPRESSION_COMBO_DESCRIPTION);

  const pipeline = normalizePipeline(row.pipeline);
  const untouchedSeed =
    isLegacySeededDefaultPipeline(pipeline) || isPreviousLossySeedPipeline(pipeline);
  if (!isSeededMetadata || !untouchedSeed) return;

  await db().execute(
    `UPDATE compression_combos
        SET description = $1, pipeline = $2::jsonb, updated_at = now()
      WHERE id = $3`,
    [
      DEFAULT_COMPRESSION_COMBO_DESCRIPTION,
      jsonb(defaultCompressionComboPipeline()),
      DEFAULT_COMPRESSION_COMBO_ID,
    ]
  );
}

/**
 * Seeds the default combo on every call (as before: one cheap statement), so it
 * reappears after a restore or reset. It becomes the default only when no other
 * combo already is (a unique index allows a single default).
 */
async function ensureCompressionComboSeed(): Promise<void> {
  await db().execute(
    `INSERT INTO compression_combos (
       id, name, description, pipeline, language_packs, output_mode, output_mode_intensity,
       is_default
     )
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, false, 'full',
             NOT EXISTS (SELECT 1 FROM compression_combos WHERE is_default))
     ON CONFLICT (id) DO NOTHING`,
    [
      DEFAULT_COMPRESSION_COMBO_ID,
      DEFAULT_COMPRESSION_COMBO_NAME,
      DEFAULT_COMPRESSION_COMBO_DESCRIPTION,
      jsonb(defaultCompressionComboPipeline()),
      jsonb(["en"]),
    ]
  );
  await upgradeLegacySeededDefaultCompressionCombo();
}

function rowToCompressionCombo(row: Row | undefined | null): CompressionCombo | null {
  if (!row) return null;
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    pipeline: normalizePipeline(row.pipeline),
    languagePacks: normalizeLanguagePacks(row.language_packs),
    outputMode: Boolean(row.output_mode),
    outputModeIntensity: String(row.output_mode_intensity ?? "full"),
    outputStyles: normalizeOutputStyles(row.output_styles),
    isDefault: Boolean(row.is_default),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

function rowToAssignment(row: Row): CompressionComboAssignment {
  return {
    id: String(row.routing_combo_id),
    compressionComboId: String(row.compression_combo_id),
    routingComboId: String(row.routing_combo_id),
    createdAt: String(row.created_at ?? ""),
  };
}

function buildComboPayload(data: Partial<CompressionCombo>, existing?: CompressionCombo) {
  const now = new Date().toISOString();
  return {
    id: existing?.id ?? data.id ?? uuidv4(),
    name: data.name?.trim() || existing?.name || "Compression Combo",
    description: data.description ?? existing?.description ?? "",
    pipeline:
      data.pipeline && data.pipeline.length > 0
        ? data.pipeline
        : existing?.pipeline && existing.pipeline.length > 0
          ? existing.pipeline
          : defaultCompressionComboPipeline(),
    languagePacks:
      data.languagePacks && data.languagePacks.length > 0
        ? data.languagePacks
        : existing?.languagePacks && existing.languagePacks.length > 0
          ? existing.languagePacks
          : ["en"],
    outputMode: data.outputMode ?? existing?.outputMode ?? false,
    outputModeIntensity: data.outputModeIntensity ?? existing?.outputModeIntensity ?? "full",
    // Explicit [] clears the combo's own selection (back to inheriting the global panel);
    // undefined leaves an existing selection untouched.
    outputStyles: data.outputStyles ?? existing?.outputStyles ?? [],
    isDefault: data.isDefault ?? existing?.isDefault ?? false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

async function clearDefaultFlag(ex: DbExecutor): Promise<void> {
  await ex.execute("UPDATE compression_combos SET is_default = false WHERE is_default");
}

export async function listCompressionCombos(): Promise<CompressionCombo[]> {
  await ensureCompressionComboSeed();
  const rows = await db().query<Row>(
    "SELECT * FROM compression_combos ORDER BY is_default DESC, lower(name) ASC, name ASC"
  );
  return rows
    .map(rowToCompressionCombo)
    .filter((combo): combo is CompressionCombo => combo !== null);
}

export async function getCompressionCombo(id: string): Promise<CompressionCombo | null> {
  await ensureCompressionComboSeed();
  const row = await db().queryOne<Row>("SELECT * FROM compression_combos WHERE id = $1", [id]);
  return rowToCompressionCombo(row);
}

export async function getDefaultCompressionCombo(): Promise<CompressionCombo | null> {
  await ensureCompressionComboSeed();
  const row = await db().queryOne<Row>(
    "SELECT * FROM compression_combos WHERE is_default ORDER BY updated_at DESC LIMIT 1"
  );
  return rowToCompressionCombo(row);
}

export async function createCompressionCombo(
  data: Partial<CompressionCombo>
): Promise<CompressionCombo> {
  await ensureCompressionComboSeed();
  const combo = buildComboPayload(data);
  await db().transaction(async (tx) => {
    if (combo.isDefault) await clearDefaultFlag(tx);
    await tx.execute(
      `INSERT INTO compression_combos (
         id, name, description, pipeline, language_packs, output_mode, output_mode_intensity,
         output_styles, is_default, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8::jsonb, $9, $10, $11)`,
      [
        combo.id,
        combo.name,
        combo.description,
        jsonb(combo.pipeline),
        jsonb(combo.languagePacks),
        combo.outputMode,
        combo.outputModeIntensity,
        jsonb(combo.outputStyles),
        combo.isDefault,
        ts(combo.createdAt),
        ts(combo.updatedAt),
      ]
    );
  });
  return (await getCompressionCombo(combo.id)) as CompressionCombo;
}

export async function updateCompressionCombo(
  id: string,
  data: Partial<CompressionCombo>
): Promise<CompressionCombo | null> {
  const existing = await getCompressionCombo(id);
  if (!existing) return null;
  const combo = buildComboPayload(data, existing);
  await db().transaction(async (tx) => {
    if (combo.isDefault) await clearDefaultFlag(tx);
    await tx.execute(
      `UPDATE compression_combos
          SET name = $1, description = $2, pipeline = $3::jsonb, language_packs = $4::jsonb,
              output_mode = $5, output_mode_intensity = $6, output_styles = $7::jsonb,
              is_default = $8, updated_at = $9
        WHERE id = $10`,
      [
        combo.name,
        combo.description,
        jsonb(combo.pipeline),
        jsonb(combo.languagePacks),
        combo.outputMode,
        combo.outputModeIntensity,
        jsonb(combo.outputStyles),
        combo.isDefault,
        ts(combo.updatedAt),
        id,
      ]
    );
  });
  return getCompressionCombo(id);
}

export async function deleteCompressionCombo(id: string): Promise<boolean> {
  const existing = await getCompressionCombo(id);
  if (!existing || existing.isDefault) return false;
  // Assignments go with the row (FK ON DELETE CASCADE).
  const result = await db().execute("DELETE FROM compression_combos WHERE id = $1", [id]);
  return result.changes > 0;
}

export async function setDefaultCompressionCombo(id: string): Promise<boolean> {
  if (!(await getCompressionCombo(id))) return false;
  await db().transaction(async (tx) => {
    await clearDefaultFlag(tx);
    await tx.execute(
      "UPDATE compression_combos SET is_default = true, updated_at = now() WHERE id = $1",
      [id]
    );
  });
  return true;
}

export async function getAssignmentsForCompressionCombo(
  id: string
): Promise<CompressionComboAssignment[]> {
  await ensureCompressionComboSeed();
  const rows = await db().query<Row>(
    "SELECT * FROM compression_combo_assignments WHERE compression_combo_id = $1 ORDER BY routing_combo_id",
    [id]
  );
  return rows.map(rowToAssignment);
}

export async function getCompressionComboForRoutingCombo(
  routingComboId: string
): Promise<CompressionCombo | null> {
  await ensureCompressionComboSeed();
  const row = await db().queryOne<Row>(
    `SELECT c.*
       FROM compression_combos c
       JOIN compression_combo_assignments a ON a.compression_combo_id = c.id
      WHERE a.routing_combo_id = $1
      LIMIT 1`,
    [routingComboId]
  );
  return rowToCompressionCombo(row);
}

const UPSERT_ASSIGNMENT_SQL = `INSERT INTO compression_combo_assignments (routing_combo_id, compression_combo_id, created_at)
   VALUES ($1, $2, now())
   ON CONFLICT (routing_combo_id) DO UPDATE
     SET compression_combo_id = EXCLUDED.compression_combo_id, created_at = EXCLUDED.created_at`;

export async function assignRoutingCombo(
  compressionComboId: string,
  routingComboId: string
): Promise<boolean> {
  if (!(await getCompressionCombo(compressionComboId)) || !routingComboId.trim()) return false;
  await db().execute(UPSERT_ASSIGNMENT_SQL, [routingComboId.trim(), compressionComboId]);
  return true;
}

// Static stackPriority map — mirrors the values defined in each engine file.
// Using a static map avoids cross-workspace imports (open-sse → src/lib/db) that
// would introduce a circular dependency detected by check:cycles.
const ENGINE_STACK_PRIORITY: Record<string, number> = {
  "session-dedup": 3,
  ccr: 4,
  lite: 5,
  rtk: 10,
  headroom: 15,
  caveman: 20,
  aggressive: 30,
  ultra: 40,
  "codex-responses": 12,
};

export async function setEngineInDefaultCombo(
  engineId: string,
  enabled: boolean,
  config?: Record<string, unknown>
): Promise<CompressionCombo | null> {
  if (!KNOWN_ENGINE_IDS.includes(engineId)) return null;
  await ensureCompressionComboSeed();

  // Read-modify-write of the pipeline document: lock the default row for the update.
  const updatedId = await db().transaction(async (tx) => {
    const row = await tx.queryOne<Row>(
      "SELECT * FROM compression_combos WHERE is_default ORDER BY updated_at DESC LIMIT 1 FOR UPDATE"
    );
    const existing = rowToCompressionCombo(row);
    if (!existing) return null;

    let newPipeline = [...existing.pipeline];
    if (enabled) {
      const idx = newPipeline.findIndex((s) => s.engine === engineId);
      if (idx >= 0) {
        if (config !== undefined) {
          newPipeline[idx] = { ...newPipeline[idx], config };
        }
      } else {
        newPipeline.push({
          engine: engineId as CompressionEngineId,
          ...(config ? { config } : {}),
        });
      }
      // Sort by stackPriority ascending so the pipeline runs in the correct order.
      newPipeline.sort((a, b) => {
        const pa = ENGINE_STACK_PRIORITY[a.engine] ?? 50;
        const pb = ENGINE_STACK_PRIORITY[b.engine] ?? 50;
        return pa - pb;
      });
    } else {
      newPipeline = newPipeline.filter((s) => s.engine !== engineId);
    }

    // Direct UPDATE — preserves empty pipeline (Fix #2) without going through
    // buildComboPayload which falls back to defaultCompressionComboPipeline() when
    // the incoming array is empty.
    await tx.execute(
      "UPDATE compression_combos SET pipeline = $1::jsonb, updated_at = now() WHERE id = $2",
      [jsonb(newPipeline), existing.id]
    );
    return existing.id;
  });

  return updatedId ? getCompressionCombo(updatedId) : null;
}

export async function updateAssignments(
  compressionComboId: string,
  routingComboIds: string[]
): Promise<boolean> {
  if (!(await getCompressionCombo(compressionComboId))) return false;
  const cleanedIds = [...new Set(routingComboIds.map((id) => id.trim()).filter(Boolean))];
  await db().transaction(async (tx) => {
    await tx.execute("DELETE FROM compression_combo_assignments WHERE compression_combo_id = $1", [
      compressionComboId,
    ]);
    // The primary key is the routing combo, so the upsert also moves a routing combo
    // away from whichever compression combo held it.
    for (const routingComboId of cleanedIds) {
      await tx.execute(UPSERT_ASSIGNMENT_SQL, [routingComboId, compressionComboId]);
    }
  });
  return true;
}
