/**
 * modelIntelligence.ts — DB domain module for model task-fitness scores.
 *
 * Persists per-model intelligence from arena ELO, models.dev tier rankings,
 * and user overrides. Resolution chain: user_override → arena_elo → models_dev_tier.
 *
 * Table: `model_intelligence`, primary key (model, source, category).
 */

import { db, ts, type DbExecutor } from "./pg";
import { bumpModelIntelligenceWriteGeneration } from "./modelIntelligenceGeneration";

// ──────────────── Types ────────────────

export interface ModelIntelligenceEntry {
  model: string;
  source: string;
  category: string;
  score: number;
  eloRaw: number | null;
  confidence: string | null;
  syncedAt: string;
  expiresAt: string | null;
  votes?: number;
  rank?: number;
}

type NewEntry = Omit<ModelIntelligenceEntry, "syncedAt">;

interface IntelligenceRow {
  model: string;
  source: string;
  category: string;
  score: number;
  elo_raw: number | null;
  confidence: string | null;
  synced_at: string | null;
  expires_at: string | null;
}

// ──────────────── Helpers ────────────────

function rowToEntry(row: IntelligenceRow): ModelIntelligenceEntry {
  return {
    model: String(row.model ?? ""),
    source: String(row.source ?? ""),
    category: String(row.category ?? ""),
    score: typeof row.score === "number" ? row.score : 0,
    eloRaw: typeof row.elo_raw === "number" ? row.elo_raw : null,
    confidence: typeof row.confidence === "string" ? row.confidence : null,
    syncedAt: String(row.synced_at ?? ""),
    expiresAt: typeof row.expires_at === "string" ? row.expires_at : null,
  };
}

const COLUMNS = "model, source, category, score, elo_raw, confidence, synced_at, expires_at";

/** Multi-row upsert; later duplicates of one (model, source, category) win, as they did row by row. */
async function upsertEntries(ex: DbExecutor, entries: NewEntry[]): Promise<number> {
  if (entries.length === 0) return 0;
  const unique = new Map<string, NewEntry>();
  for (const entry of entries) {
    // A NaN/Infinity score would fail the CHECK and abort the whole batch: skip that row.
    if (!Number.isFinite(entry.score)) continue;
    unique.set(`${entry.model}\u0000${entry.source}\u0000${entry.category}`, entry);
  }
  const rows = [...unique.values()];
  if (rows.length === 0) return 0;
  await ex.execute(
    `INSERT INTO model_intelligence (model, source, category, score, elo_raw, confidence, synced_at, expires_at)
     SELECT t.model, t.source, t.category, t.score, t.elo_raw, t.confidence, now(), t.expires_at
     FROM unnest($1::text[], $2::text[], $3::text[], $4::float8[], $5::int[], $6::text[], $7::timestamptz[])
       AS t(model, source, category, score, elo_raw, confidence, expires_at)
     ON CONFLICT (model, source, category) DO UPDATE SET
       score = EXCLUDED.score, elo_raw = EXCLUDED.elo_raw, confidence = EXCLUDED.confidence,
       synced_at = EXCLUDED.synced_at, expires_at = EXCLUDED.expires_at`,
    [
      rows.map((e) => e.model),
      rows.map((e) => e.source),
      rows.map((e) => e.category),
      // The table CHECKs 0..1; the scorers already stay inside it, this only guards drift.
      rows.map((e) => Math.min(1, Math.max(0, e.score))),
      rows.map((e) => (typeof e.eloRaw === "number" ? Math.round(e.eloRaw) : null)),
      rows.map((e) => e.confidence ?? null),
      rows.map((e) => ts(e.expiresAt)),
    ]
  );
  return entries.length;
}

// ──────────────── CRUD ────────────────

export async function getModelIntelligence(
  model: string,
  category: string
): Promise<ModelIntelligenceEntry | null> {
  const row = await db().queryOne<IntelligenceRow>(
    `SELECT ${COLUMNS} FROM model_intelligence
     WHERE model = $1 AND category = $2
       AND source IN ('user_override', 'arena_elo', 'models_dev_tier')
       AND (expires_at IS NULL OR expires_at > now())
     ORDER BY CASE source
       WHEN 'user_override' THEN 1
       WHEN 'arena_elo' THEN 2
       WHEN 'models_dev_tier' THEN 3
     END
     LIMIT 1`,
    [model, category]
  );
  return row ? rowToEntry(row) : null;
}

export async function getModelIntelligenceBySource(
  model: string,
  source: string,
  category: string
): Promise<ModelIntelligenceEntry | null> {
  const row = await db().queryOne<IntelligenceRow>(
    `SELECT ${COLUMNS} FROM model_intelligence
     WHERE model = $1 AND source = $2 AND category = $3
       AND (expires_at IS NULL OR expires_at > now())`,
    [model, source, category]
  );
  return row ? rowToEntry(row) : null;
}

// Every write bumps the generation before the statement (so readers drop their memo) and
// again after it commits (a reader that cached between the two would otherwise keep the
// pre-write value for the new generation).
async function withWriteGeneration<T>(write: () => Promise<T>): Promise<T> {
  bumpModelIntelligenceWriteGeneration();
  try {
    return await write();
  } finally {
    bumpModelIntelligenceWriteGeneration();
  }
}

export async function upsertModelIntelligence(entry: NewEntry): Promise<void> {
  await withWriteGeneration(() => upsertEntries(db(), [entry]));
}

export async function deleteModelIntelligence(
  model: string,
  source: string,
  category: string
): Promise<boolean> {
  const result = await withWriteGeneration(() =>
    db().execute(
      "DELETE FROM model_intelligence WHERE model = $1 AND source = $2 AND category = $3",
      [model, source, category]
    )
  );
  return result.changes > 0;
}

export async function deleteExpiredIntelligence(source?: string): Promise<number> {
  const result = await withWriteGeneration(() =>
    source
      ? db().execute(
          "DELETE FROM model_intelligence WHERE expires_at IS NOT NULL AND expires_at < now() AND source = $1",
          [source]
        )
      : db().execute(
          "DELETE FROM model_intelligence WHERE expires_at IS NOT NULL AND expires_at < now()"
        )
  );
  return result.changes;
}

export async function deleteModelIntelligenceBySource(source: string): Promise<number> {
  const result = await withWriteGeneration(() =>
    db().execute("DELETE FROM model_intelligence WHERE source = $1", [source])
  );
  return result.changes;
}

export async function listModelIntelligence(filters?: {
  source?: string;
  category?: string;
}): Promise<ModelIntelligenceEntry[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.source) {
    params.push(filters.source);
    conditions.push(`source = $${params.length}`);
  }
  if (filters?.category) {
    params.push(filters.category);
    conditions.push(`category = $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await db().query<IntelligenceRow>(
    `SELECT ${COLUMNS} FROM model_intelligence ${where} ORDER BY model ASC, source ASC, category ASC`,
    params
  );
  return rows.map(rowToEntry);
}

export async function bulkUpsertModelIntelligence(entries: NewEntry[]): Promise<number> {
  if (entries.length === 0) {
    bumpModelIntelligenceWriteGeneration();
    return 0;
  }
  return withWriteGeneration(() => db().transaction((tx) => upsertEntries(tx, entries)));
}

export async function getResolvedTaskFitness(
  model: string,
  category: string
): Promise<number | null> {
  const entry = await getModelIntelligence(model, category);
  return entry ? entry.score : null;
}

/**
 * Latest synced_at for a source, as an ISO string (or null when the source
 * has no rows). Backs the arenaEloSync freshness guard: a non-empty dataset
 * synced within the sync interval does not need re-fetching.
 */
export async function getLatestSyncedAt(source: string): Promise<string | null> {
  const row = await db().queryOne<{ latest: string | null }>(
    "SELECT max(synced_at) AS latest FROM model_intelligence WHERE source = $1",
    [source]
  );
  return row?.latest ?? null;
}

/**
 * Atomically replace a source's dataset: upsert every refreshed entry and
 * prune rows for that source that are not in the refreshed set — one
 * transaction, so a crash mid-refresh can never leave a half-replaced table.
 *
 * This is the safe replacement for the old delete-expired-then-upsert flow,
 * which lost data when a fetch failed after the delete (remediation 2026-09-12).
 */
export async function applyArenaEloRefresh(
  entries: NewEntry[],
  source = "arena_elo"
): Promise<{ upserted: number; pruned: number }> {
  return withWriteGeneration(() =>
    db().transaction(async (tx) => {
      const upserted = await upsertEntries(tx, entries);
      // Prune on (model, category) pairs: correct for composite keys (a plain NOT IN over
      // model names is not).
      const pruned = await tx.execute(
        `DELETE FROM model_intelligence
         WHERE source = $1
           AND (model, category) NOT IN (SELECT m, c FROM unnest($2::text[], $3::text[]) AS t(m, c))`,
        [source, entries.map((e) => e.model), entries.map((e) => e.category)]
      );
      return { upserted, pruned: pruned.changes };
    })
  );
}

/**
 * Write a user_override entry for a model × category combination.
 * Used by taskFitness.ts resolution chain as Layer 1 (highest priority).
 *
 * @param model - Model identifier
 * @param category - Task category
 * @param score - Fitness score [0..1]
 */
export async function setUserFitnessOverrideEntry(
  model: string,
  category: string,
  score: number
): Promise<void> {
  await upsertModelIntelligence({
    model: model.toLowerCase(),
    source: "user_override",
    category: category.toLowerCase(),
    score: Math.max(0, Math.min(1, score)),
    eloRaw: null,
    confidence: null,
    expiresAt: null,
  });
}

/**
 * Delete a user_override entry for a model × category combination.
 *
 * @param model - Model identifier
 * @param category - Task category
 * @returns true if an entry was deleted
 */
export async function deleteUserFitnessOverrideEntry(
  model: string,
  category: string
): Promise<boolean> {
  return deleteModelIntelligence(model.toLowerCase(), "user_override", category.toLowerCase());
}
