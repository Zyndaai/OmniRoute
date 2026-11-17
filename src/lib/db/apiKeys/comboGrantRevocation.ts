/**
 * Revoke a deleted combo's name from every API key's `allowed_combos`.
 *
 * Combo grants are stored by NAME, so a grant left behind after the combo row is
 * deleted would silently apply to any combo later created under the same name.
 * The caller runs this inside the same transaction as the combo DELETE.
 */

import { ALL_COMBOS_ACCESS_RULE } from "@/shared/constants/comboAccess";
import { jsonb, type DbExecutor } from "@/lib/db/pg";

type Db = DbExecutor;

// Same normalization as `normalizeComboAccessName` in `@/shared/utils/apiKeyPolicy`
// (kept local: that module imports the combo repository, which calls this helper).
function grantedComboName(rule: string): string {
  const trimmed = rule.trim();
  return trimmed.startsWith("combo/") ? trimmed.slice(6).trim() || trimmed : trimmed;
}

/**
 * Strip `comboName` (bare or `combo/`-prefixed, case-insensitive) from every key's
 * `allowed_combos`. Returns the ids of the keys that changed.
 *
 * - Skipped while another combo with the same name (any case) still exists:
 *   requests resolve combos case-insensitively, so that grant can still apply.
 * - `combo/*` and every other rule are kept.
 * - An emptied list is written as `[]` (deny all), never NULL (legacy allow-all).
 * - NULL and malformed lists are left untouched.
 */
export async function revokeComboGrantsByName(db: Db, comboName: string): Promise<string[]> {
  const target = comboName.trim().toLowerCase();
  if (!target) return [];

  const stillExists = await db.queryOne(
    "SELECT 1 FROM combos WHERE lower(name) = lower($1) LIMIT 1",
    [comboName.trim()]
  );
  if (stillExists) return [];

  // FOR UPDATE: the caller runs inside the combo-delete transaction; lock the rows we rewrite.
  const rows = await db.query<{ id: string; allowed_combos: unknown }>(
    "SELECT id, allowed_combos FROM api_keys WHERE allowed_combos IS NOT NULL FOR UPDATE"
  );
  const changed: string[] = [];

  for (const row of rows) {
    // jsonb arrives parsed; a legacy JSON string (double-encoded) is still tolerated.
    let rules: unknown = row.allowed_combos;
    if (typeof rules === "string") {
      try {
        rules = JSON.parse(rules);
      } catch {
        continue;
      }
    }
    if (!Array.isArray(rules)) continue;

    const remaining = rules.filter(
      (rule) =>
        typeof rule !== "string" ||
        rule === ALL_COMBOS_ACCESS_RULE ||
        grantedComboName(rule).toLowerCase() !== target
    );
    if (remaining.length === rules.length) continue;

    await db.execute("UPDATE api_keys SET allowed_combos = $1::jsonb WHERE id = $2", [
      jsonb(remaining),
      row.id,
    ]);
    changed.push(row.id);
  }

  return changed;
}
