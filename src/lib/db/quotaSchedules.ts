/**
 * db/quotaSchedules.ts — CRUD for the quota_schedules table.
 *
 * Time-aware quota windows for a quota pool: when OmniRoute may use the pool's
 * accounts, how much upstream quota it must leave behind (`reserve_percent`),
 * and how much it may consume itself inside the window (`budget_*`).
 * See src/lib/quota/schedules.ts for the semantics.
 *
 * All SQL goes through parameterised statements — never raw string interpolation.
 *
 * The QuotaSchedule shape is imported type-only from the quota layer, so this
 * module stays the single mapping point between rows and the engine's type
 * without creating a runtime import cycle.
 */

import { db, jsonb } from "./pg";
import type {
  QuotaSchedule,
  ReserveRule,
  ScheduleBudgetUnit,
  ScheduleMode,
} from "@/lib/quota/schedules";
import type { QuotaWindow } from "@/lib/quota/dimensions";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ScheduleRow {
  id: string;
  pool_id: string;
  label: string | null;
  days: number[] | string | null;
  start_minute: number;
  end_minute: number;
  timezone: string | null;
  mode: string;
  reserves: unknown;
  budget_value: number | null;
  budget_unit: string | null;
  budget_window: string;
  priority: number;
  enabled: boolean;
}

const VALID_MODES: ReadonlySet<string> = new Set<ScheduleMode>(["allow", "block"]);
const VALID_BUDGET_UNITS: ReadonlySet<string> = new Set<ScheduleBudgetUnit>([
  "requests",
  "tokens",
  "usd",
]);
const VALID_WINDOWS: ReadonlySet<string> = new Set<QuotaWindow>([
  "hourly",
  "5h",
  "daily",
  "weekly",
  "monthly",
]);

/**
 * Fail-SAFE mode normalization at the read boundary. A row whose mode is neither
 * "allow" nor "block" is read as "block": an unrecognised rule must never widen
 * access. Mirrors the `normalizePolicy` convention in db/quotaPools.ts.
 */
function normalizeMode(value: string): ScheduleMode {
  return VALID_MODES.has(value) ? (value as ScheduleMode) : "block";
}

/**
 * Normalise a day list to sorted, de-duplicated 0..6. Accepts the `smallint[]`
 * column value, or a legacy comma-separated string.
 */
export function parseDays(value: string | ReadonlyArray<number | string> | null | undefined): number[] {
  const parts: Array<number | string> =
    typeof value === "string" ? value.split(",") : Array.isArray(value) ? [...value] : [];
  const seen = new Set<number>();
  for (const part of parts) {
    const trimmed = typeof part === "string" ? part.trim() : part;
    // Number("") is 0, so an empty segment would otherwise read as Sunday and
    // turn a day-less row into a Sunday-only window.
    if (trimmed === "") continue;
    const n = Number(trimmed);
    if (Number.isInteger(n) && n >= 0 && n <= 6) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

const VALID_RESERVE_WINDOWS: ReadonlySet<string> = new Set([...VALID_WINDOWS, "any"]);

/**
 * Parse the reserves column (jsonb array, or a legacy JSON string), dropping
 * anything malformed.
 *
 * A reserve that cannot be understood is discarded rather than guessed at: the
 * alternative — inventing a floor — would silently throttle a pool the operator
 * believes is unrestricted.
 */
export function parseReserves(raw: unknown): ReserveRule[] {
  if (raw === null || raw === undefined || raw === "") return [];
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];

  const rules: ReserveRule[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const { window, percent } = entry as { window?: unknown; percent?: unknown };
    if (typeof window !== "string" || !VALID_RESERVE_WINDOWS.has(window)) continue;
    if (typeof percent !== "number" || !Number.isFinite(percent)) continue;
    if (percent < 0 || percent > 100) continue;
    rules.push({ window: window as ReserveRule["window"], percent });
  }
  return rules;
}

function serializeReserves(reserves: ReserveRule[] | undefined): string | null {
  if (!reserves || reserves.length === 0) return null;
  return jsonb(reserves);
}

function rowToSchedule(row: ScheduleRow): QuotaSchedule {
  const schedule: QuotaSchedule = {
    id: row.id,
    poolId: row.pool_id,
    days: parseDays(row.days),
    startMinute: row.start_minute,
    endMinute: row.end_minute,
    timezone: row.timezone,
    mode: normalizeMode(row.mode),
    reserves: parseReserves(row.reserves),
    budgetWindow: VALID_WINDOWS.has(row.budget_window)
      ? (row.budget_window as QuotaWindow)
      : "daily",
    priority: row.priority,
    enabled: row.enabled === true,
  };
  if (row.label != null) schedule.label = row.label;
  // A budget is only meaningful as a (value, unit) pair — an orphan half is
  // dropped so the enforce path never reads a value it cannot attribute.
  if (
    row.budget_value != null &&
    row.budget_unit != null &&
    VALID_BUDGET_UNITS.has(row.budget_unit)
  ) {
    schedule.budgetValue = row.budget_value;
    schedule.budgetUnit = row.budget_unit as ScheduleBudgetUnit;
  }
  return schedule;
}

function makeId(): string {
  return `sched-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A schedule as submitted by a caller: the id and poolId are assigned here. */
export type ScheduleInput = Omit<QuotaSchedule, "id" | "poolId"> & { id?: string };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * All schedules for a pool, ordered priority DESC then id ASC — the same order
 * `resolveActiveSchedule` applies, so the UI list reads as the engine resolves.
 * Returns [] when the database is unavailable: schedules are additive, and
 * their absence must never block traffic.
 */
export async function listSchedules(poolId: string): Promise<QuotaSchedule[]> {
  try {
    const rows = await db().query<ScheduleRow>(
      `SELECT id, pool_id, label, days, start_minute, end_minute, timezone, mode,
              reserves, budget_value, budget_unit, budget_window, priority, enabled
       FROM quota_schedules
       WHERE pool_id = $1
       ORDER BY priority DESC, id ASC`,
      [poolId]
    );
    return rows.map(rowToSchedule);
  } catch {
    // DB unavailable — fail-open.
    return [];
  }
}

/** Only the enabled rows — what the hot path needs. */
export async function listEnabledSchedules(poolId: string): Promise<QuotaSchedule[]> {
  return (await listSchedules(poolId)).filter((s) => s.enabled);
}

/**
 * Replace a pool's entire schedule set in one transaction.
 *
 * Whole-set replacement (rather than per-row PATCH) keeps the editor honest: the
 * resolution rules are order- and overlap-sensitive, so the UI always reasons
 * about the complete set it is about to save.
 *
 * @returns the persisted schedules, in resolution order.
 */
export async function replaceSchedules(
  poolId: string,
  schedules: ScheduleInput[]
): Promise<QuotaSchedule[]> {
  await db().transaction(async (tx) => {
    await tx.execute("DELETE FROM quota_schedules WHERE pool_id = $1", [poolId]);
    for (const s of schedules) {
      const hasBudget = s.budgetValue != null && s.budgetUnit != null;
      await tx.execute(
        `INSERT INTO quota_schedules
           (id, pool_id, label, days, start_minute, end_minute, timezone, mode,
            reserves, budget_value, budget_unit, budget_window, priority, enabled)
         VALUES ($1, $2, $3, $4::smallint[], $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14)`,
        [
          s.id ?? makeId(),
          poolId,
          s.label ?? null,
          parseDays(s.days),
          s.startMinute,
          s.endMinute,
          s.timezone ?? null,
          s.mode,
          serializeReserves(s.reserves),
          hasBudget ? s.budgetValue : null,
          hasBudget ? s.budgetUnit : null,
          s.budgetWindow,
          Math.round(s.priority),
          s.enabled === true,
        ]
      );
    }
  });

  return listSchedules(poolId);
}

/**
 * Drop every schedule of a pool. Deleting a pool removes its schedules through
 * the foreign key, so this is only needed to clear a pool's schedules while the
 * pool stays.
 */
export async function deleteSchedulesForPool(poolId: string): Promise<number> {
  try {
    return (await db().execute("DELETE FROM quota_schedules WHERE pool_id = $1", [poolId]))
      .changes;
  } catch {
    return 0;
  }
}
