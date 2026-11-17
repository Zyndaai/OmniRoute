/**
 * db/skills.ts — Database operations for the skills table.
 *
 * Encapsulates all SQL for the `skills` table so that route handlers never
 * contain raw SQL (Hard Rule #5).
 */

import { db } from "./pg";

// ──────────────── Allowed patch columns ────────────────
//
// updateSkill builds a SET clause dynamically. To prevent SQL injection the
// column names are validated against this allowlist of known, writable columns.
// Any key in the patch that is NOT in this set is silently ignored.
const UPDATABLE_COLUMNS = new Set<string>([
  "enabled",
  "mode",
  // future-safe: add writable columns here as schema grows
]);

export interface SkillPatch {
  enabled?: number | boolean;
  mode?: string;
}

/**
 * Update a skill row with a parameterized, injection-safe dynamic SET clause.
 *
 * @param id   - Row ID of the skill to update.
 * @param patch - Plain-object of column→value pairs to apply.
 *               Only columns present in UPDATABLE_COLUMNS are touched;
 *               unknown keys are silently ignored.
 *
 * The function always sets `updated_at = now()` so the record's timestamp reflects
 * the mutation.
 *
 * @returns number of rows changed (0 if skill not found, 1 if updated).
 */
export async function updateSkill(id: string, patch: SkillPatch): Promise<number> {
  const setClauses: string[] = [];
  const params: unknown[] = [];

  for (const [key, value] of Object.entries(patch)) {
    if (!UPDATABLE_COLUMNS.has(key)) continue; // allowlist guard
    params.push(key === "enabled" ? Boolean(value) : value);
    setClauses.push(`${key} = $${params.length}`);
  }

  if (setClauses.length === 0) {
    // Nothing to update (all keys were filtered out).
    return 0;
  }

  setClauses.push("updated_at = now()");
  params.push(id);

  const result = await db().execute(
    `UPDATE skills SET ${setClauses.join(", ")} WHERE id = $${params.length}`,
    params
  );
  return result.changes;
}
