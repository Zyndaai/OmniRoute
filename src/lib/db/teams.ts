import { db, type DbExecutor } from "@/lib/db/pg";
import { invalidateApiKeyPolicyCache, loadApiKeyPolicyConfig } from "@/lib/db/readCache";

export type TeamStatus = "active" | "archived";
export type TeamBudgetDuration = "1d" | "7d" | "30d";

export interface Team {
  id: string;
  name: string;
  description: string;
  status: TeamStatus;
  maxBudgetUsd: number | null;
  budgetDuration: TeamBudgetDuration | null;
  budgetResetAt: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface TeamCreateInput {
  name: string;
  description?: string;
  maxBudgetUsd?: number | null;
  budgetDuration?: TeamBudgetDuration | null;
}

export interface TeamUpdateInput {
  name?: string;
  description?: string;
  maxBudgetUsd?: number | null;
  budgetDuration?: TeamBudgetDuration | null;
}

export interface ApiKeyBillingTeamHistory {
  id: string;
  apiKeyId: string;
  teamId: string;
  validFrom: string;
  validTo: string | null;
  createdAt: string;
}

export interface TeamMember {
  apiKeyId: string;
  apiKeyName: string;
  assignedAt: string;
}

type TeamRow = {
  id: string;
  name: string;
  description: string | null;
  status: TeamStatus;
  max_budget_usd: number | null;
  budget_duration: TeamBudgetDuration | null;
  budget_reset_at: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type BillingRow = {
  id: string;
  api_key_id: string;
  team_id: string;
  valid_from: string;
  valid_to: string | null;
  created_at: string;
};

const BUDGET_DURATION_MS: Record<TeamBudgetDuration, number> = {
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const CONCURRENT_ASSIGNMENT_ERROR =
  "API key billing team changed concurrently; retry the assignment";

const DUPLICATE_NAME_ERROR = "Team name already exists";

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; kind?: unknown };
  return e.code === "23505" || e.kind === "unique_violation";
}

function ms(value: string): number {
  return Date.parse(value);
}

function normalizeIso(value: string | undefined = undefined): string {
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid effective timestamp");
  return date.toISOString();
}

function normalizeName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("Team name is required");
  if (name.length > 200) throw new Error("Team name must be at most 200 characters");
  return name;
}

function normalizeBudget(
  input: {
    maxBudgetUsd?: number | null;
    budgetDuration?: TeamBudgetDuration | null;
  },
  nowIso: string
): {
  maxBudgetUsd: number | null;
  budgetDuration: TeamBudgetDuration | null;
  budgetResetAt: string | null;
} {
  const hasBudget = input.maxBudgetUsd !== undefined || input.budgetDuration !== undefined;
  if (!hasBudget) {
    return { maxBudgetUsd: null, budgetDuration: null, budgetResetAt: null };
  }
  if (input.maxBudgetUsd == null && input.budgetDuration == null) {
    return { maxBudgetUsd: null, budgetDuration: null, budgetResetAt: null };
  }
  const amount = Number(input.maxBudgetUsd);
  const duration = input.budgetDuration;
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("maxBudgetUsd must be greater than zero");
  }
  if (!duration || !(duration in BUDGET_DURATION_MS)) {
    throw new Error("budgetDuration must be one of 1d, 7d, or 30d");
  }
  return {
    maxBudgetUsd: amount,
    budgetDuration: duration,
    budgetResetAt: new Date(Date.parse(nowIso) + BUDGET_DURATION_MS[duration]).toISOString(),
  };
}

function rowToTeam(row: TeamRow): Team {
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    status: row.status,
    maxBudgetUsd: row.max_budget_usd,
    budgetDuration: row.budget_duration,
    budgetResetAt: row.budget_reset_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function rowToBillingHistory(row: BillingRow): ApiKeyBillingTeamHistory {
  return {
    id: row.id,
    apiKeyId: row.api_key_id,
    teamId: row.team_id,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    createdAt: row.created_at,
  };
}

export async function createTeam(input: TeamCreateInput): Promise<Team> {
  const now = new Date().toISOString();
  const budget = normalizeBudget(input, now);
  const id = crypto.randomUUID();
  try {
    await db().execute(
      `INSERT INTO teams (
        id, name, description, status, max_budget_usd, budget_duration,
        budget_reset_at, created_at, updated_at
      ) VALUES ($1, $2, $3, 'active', $4, $5, $6::timestamptz, $7::timestamptz, $7::timestamptz)`,
      [
        id,
        normalizeName(input.name),
        input.description?.trim() || "",
        budget.maxBudgetUsd,
        budget.budgetDuration,
        budget.budgetResetAt,
        now,
      ]
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new Error(DUPLICATE_NAME_ERROR);
    throw error;
  }
  return (await getTeam(id))!;
}

export async function listTeams(options: { includeArchived?: boolean } = {}): Promise<Team[]> {
  const rows = options.includeArchived
    ? await db().query<TeamRow>("SELECT * FROM teams ORDER BY created_at ASC")
    : await db().query<TeamRow>(
        "SELECT * FROM teams WHERE status = 'active' ORDER BY created_at ASC"
      );
  return rows.map(rowToTeam);
}

export async function getTeam(id: string): Promise<Team | null> {
  const row = await db().queryOne<TeamRow>("SELECT * FROM teams WHERE id = $1", [id]);
  return row ? rowToTeam(row) : null;
}

export async function updateTeam(id: string, input: TeamUpdateInput): Promise<Team | null> {
  const existing = await getTeam(id);
  if (!existing) return null;
  if (existing.status !== "active") throw new Error("Archived teams cannot be updated");

  const now = new Date().toISOString();
  const params: unknown[] = [now];
  const updates: string[] = ["updated_at = $1::timestamptz"];
  const set = (column: string, value: unknown, cast = "") => {
    params.push(value);
    updates.push(`${column} = $${params.length}${cast}`);
  };
  if (input.name !== undefined) set("name", normalizeName(input.name));
  if (input.description !== undefined) set("description", input.description.trim());
  if (input.maxBudgetUsd !== undefined || input.budgetDuration !== undefined) {
    const budget = normalizeBudget(
      {
        maxBudgetUsd: input.maxBudgetUsd !== undefined ? input.maxBudgetUsd : existing.maxBudgetUsd,
        budgetDuration:
          input.budgetDuration !== undefined ? input.budgetDuration : existing.budgetDuration,
      },
      now
    );
    set("max_budget_usd", budget.maxBudgetUsd);
    set("budget_duration", budget.budgetDuration);
    // Editing a live soft budget must not restart its rolling cadence. A new
    // reset instant is minted only when a budget is first enabled; disabling
    // it still clears all three fields together.
    set(
      "budget_reset_at",
      budget.maxBudgetUsd !== null && existing.budgetResetAt
        ? existing.budgetResetAt
        : budget.budgetResetAt,
      "::timestamptz"
    );
  }
  params.push(id);
  try {
    await db().execute(
      `UPDATE teams SET ${updates.join(", ")} WHERE id = $${params.length}`,
      params
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new Error(DUPLICATE_NAME_ERROR);
    throw error;
  }
  invalidateApiKeyPolicyCache();
  const updated = await getTeam(id);
  if (updated?.maxBudgetUsd && updated.budgetDuration && updated.budgetResetAt) {
    await advanceTeamBudgetWindow(updated, Date.now());
  }
  return getTeam(id);
}

export async function archiveTeam(id: string, archivedAt?: string): Promise<Team | null> {
  const team = await getTeam(id);
  if (!team) return null;
  if (team.status === "archived") return team;
  const when = normalizeIso(archivedAt);
  await db().transaction(async (tx) => {
    // Lock the team row so a concurrent assignment (FOR SHARE) cannot bind a key
    // between closing the open bindings and flipping the status.
    await tx.queryOne("SELECT id FROM teams WHERE id = $1 FOR UPDATE", [id]);
    // Close every still-open binding of this team. `valid_to` must satisfy the
    // CHECK (valid_to IS NULL OR valid_to > valid_from), which a same-instant
    // archive would violate: a key assigned in the same millisecond the team is
    // archived has valid_from === when. Archiving is an unconditional
    // administrative action with no client-supplied timestamp, so rejecting it
    // would turn an internal clock-granularity collision into a spurious 500 and
    // leave the team active. Clamp the degenerate interval to valid_from + 1ms
    // instead, keeping the interval non-empty and the archive effective.
    const open = await tx.query<{ id: string; valid_from: string }>(
      "SELECT id, valid_from FROM api_key_billing_team_history WHERE team_id = $1 AND valid_to IS NULL",
      [id]
    );
    for (const binding of open) {
      const validTo =
        ms(when) > ms(binding.valid_from)
          ? when
          : new Date(ms(binding.valid_from) + 1).toISOString();
      await tx.execute(
        "UPDATE api_key_billing_team_history SET valid_to = $1::timestamptz WHERE id = $2 AND valid_to IS NULL",
        [validTo, binding.id]
      );
    }
    await tx.execute(
      `UPDATE teams
       SET status = 'archived', archived_at = $1::timestamptz, updated_at = $1::timestamptz
       WHERE id = $2`,
      [when, id]
    );
  });
  invalidateApiKeyPolicyCache();
  return getTeam(id);
}

async function assertAssignableTeamAndKey(
  tx: DbExecutor,
  teamId: string,
  apiKeyId: string
): Promise<void> {
  // FOR SHARE on the team blocks a concurrent archive; FOR NO KEY UPDATE on the key
  // serializes concurrent assignments of the same key.
  const team = await tx.queryOne<{ status: TeamStatus }>(
    "SELECT status FROM teams WHERE id = $1 FOR SHARE",
    [teamId]
  );
  if (!team) throw new Error("Team not found");
  if (team.status !== "active") throw new Error("Cannot assign an API key to an archived team");
  const key = await tx.queryOne("SELECT id FROM api_keys WHERE id = $1 FOR NO KEY UPDATE", [
    apiKeyId,
  ]);
  if (!key) throw new Error("API key not found");
}

// A closed interval may end just after a same-instant archive. Reject genuinely
// backdated explicit assignments; advance an implicit wall-clock reassignment to
// the prior half-open end without changing stored history.
async function resolveAssignmentInstant(
  tx: DbExecutor,
  apiKeyId: string,
  when: string,
  explicit: boolean
): Promise<string> {
  const latestClosed = await tx.queryOne<{ valid_to: string | null }>(
    "SELECT MAX(valid_to) AS valid_to FROM api_key_billing_team_history WHERE api_key_id = $1 AND valid_to IS NOT NULL",
    [apiKeyId]
  );
  const validTo = latestClosed?.valid_to ?? null;
  if (!validTo || ms(when) >= ms(validTo)) return when;
  if (explicit && ms(validTo) - ms(when) > 1) {
    throw new Error("Assignment time overlaps closed billing history");
  }
  return validTo;
}

async function closeActiveBinding(
  tx: DbExecutor,
  current: BillingRow,
  when: string
): Promise<void> {
  if (ms(when) <= ms(current.valid_from)) {
    throw new Error("Assignment time must be after the active assignment start");
  }
  const closed = await tx.execute(
    "UPDATE api_key_billing_team_history SET valid_to = $1::timestamptz WHERE id = $2 AND valid_to IS NULL",
    [when, current.id]
  );
  if (closed.changes !== 1) throw new Error(CONCURRENT_ASSIGNMENT_ERROR);
}

async function insertBillingBinding(tx: DbExecutor, row: BillingRow): Promise<void> {
  try {
    await tx.execute(
      `INSERT INTO api_key_billing_team_history
        (id, api_key_id, team_id, valid_from, valid_to, created_at)
       VALUES ($1, $2, $3, $4::timestamptz, NULL, $5::timestamptz)`,
      [row.id, row.api_key_id, row.team_id, row.valid_from, row.created_at]
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new Error(CONCURRENT_ASSIGNMENT_ERROR);
    throw error;
  }
}

export async function assignApiKeyBillingTeam(
  apiKeyId: string,
  teamId: string,
  effectiveAt?: string,
  expectedTeamId?: string | null
): Promise<ApiKeyBillingTeamHistory> {
  const requestedAt = normalizeIso(effectiveAt);

  const binding = await db().transaction(async (tx) => {
    await assertAssignableTeamAndKey(tx, teamId, apiKeyId);

    const current = await tx.queryOne<BillingRow>(
      "SELECT * FROM api_key_billing_team_history WHERE api_key_id = $1 AND valid_to IS NULL",
      [apiKeyId]
    );
    if (expectedTeamId !== undefined && (current?.team_id ?? null) !== expectedTeamId) {
      throw new Error(CONCURRENT_ASSIGNMENT_ERROR);
    }
    if (current?.team_id === teamId) {
      return rowToBillingHistory(current);
    }
    const when = await resolveAssignmentInstant(tx, apiKeyId, requestedAt, Boolean(effectiveAt));
    if (current) await closeActiveBinding(tx, current, when);

    const row: BillingRow = {
      id: crypto.randomUUID(),
      api_key_id: apiKeyId,
      team_id: teamId,
      valid_from: when,
      valid_to: null,
      created_at: when,
    };
    await insertBillingBinding(tx, row);
    return rowToBillingHistory(row);
  });
  invalidateApiKeyPolicyCache();
  return binding;
}

export async function unassignApiKeyBillingTeam(
  apiKeyId: string,
  effectiveAt?: string,
  expectedTeamId?: string
): Promise<boolean> {
  const when = normalizeIso(effectiveAt);
  const current = await db().queryOne<{ id: string; team_id: string; valid_from: string }>(
    "SELECT id, team_id, valid_from FROM api_key_billing_team_history WHERE api_key_id = $1 AND valid_to IS NULL",
    [apiKeyId]
  );
  if (!current || (expectedTeamId && current.team_id !== expectedTeamId)) return false;
  if (ms(when) <= ms(current.valid_from))
    throw new Error("Unassignment time must be after assignment start");
  const result = await db().execute(
    "UPDATE api_key_billing_team_history SET valid_to = $1::timestamptz WHERE id = $2 AND valid_to IS NULL",
    [when, current.id]
  );
  invalidateApiKeyPolicyCache();
  return result.changes > 0;
}

/** Read on every request (team usage limits): cached per key, see loadApiKeyPolicyConfig. */
export async function getActiveBillingTeamForApiKey(apiKeyId: string): Promise<Team | null> {
  return loadApiKeyPolicyConfig(`team:${apiKeyId}`, async () => {
    const row = await db().queryOne<TeamRow>(
      `SELECT teams.*
         FROM api_key_billing_team_history binding
         JOIN teams ON teams.id = binding.team_id
         WHERE binding.api_key_id = $1 AND binding.valid_to IS NULL AND teams.status = 'active'`,
      [apiKeyId]
    );
    return row ? rowToTeam(row) : null;
  });
}

export async function resolveBillingTeamIdForApiKeyAt(
  apiKeyId: string | null | undefined,
  at: string
): Promise<string | null> {
  if (!apiKeyId) return null;
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) return null;
  const row = await db().queryOne<{ team_id: string }>(
    `SELECT team_id
       FROM api_key_billing_team_history
       WHERE api_key_id = $1 AND valid_from <= $2::timestamptz AND (valid_to IS NULL OR valid_to > $2::timestamptz)
       ORDER BY valid_from DESC LIMIT 1`,
    [apiKeyId, new Date(atMs).toISOString()]
  );
  return row?.team_id ?? null;
}

export async function listApiKeyBillingHistory(
  apiKeyId: string
): Promise<ApiKeyBillingTeamHistory[]> {
  const rows = await db().query<BillingRow>(
    "SELECT * FROM api_key_billing_team_history WHERE api_key_id = $1 ORDER BY valid_from ASC",
    [apiKeyId]
  );
  return rows.map(rowToBillingHistory);
}

export async function listAllApiKeyBillingHistory(): Promise<ApiKeyBillingTeamHistory[]> {
  const rows = await db().query<BillingRow>(
    "SELECT * FROM api_key_billing_team_history ORDER BY valid_from ASC"
  );
  return rows.map(rowToBillingHistory);
}

export async function listTeamMembers(teamId: string): Promise<TeamMember[]> {
  return db().query<TeamMember>(
    `SELECT binding.api_key_id AS "apiKeyId", api_keys.name AS "apiKeyName",
              binding.valid_from AS "assignedAt"
       FROM api_key_billing_team_history binding
       JOIN api_keys ON api_keys.id = binding.api_key_id
       WHERE binding.team_id = $1 AND binding.valid_to IS NULL
       ORDER BY lower(api_keys.name) ASC`,
    [teamId]
  );
}

export interface TeamKeyOption {
  id: string;
  name: string | null;
  teamId: string | null;
  teamName: string | null;
}

/** Management projection: never select credential columns. */
export async function listTeamKeyOptions(): Promise<TeamKeyOption[]> {
  return db().query<TeamKeyOption>(
    `SELECT k.id, k.name, t.id AS "teamId", t.name AS "teamName"
    FROM api_keys k
    LEFT JOIN api_key_billing_team_history b ON b.api_key_id = k.id AND b.valid_to IS NULL
    LEFT JOIN teams t ON t.id = b.team_id AND t.status = 'active'
    ORDER BY lower(k.name), k.id`
  );
}

/** Whether retained UTC-day buckets overlap a non-midnight budget boundary.
 * The existing soft policy excludes those buckets; the dashboard must not imply
 * that the displayed subtotal or remaining allowance is complete. */
export async function hasPartialRetainedTeamUsage(
  teamId: string,
  start: string,
  reset: string
): Promise<boolean> {
  const startDate = start.slice(0, 10);
  const endDate = reset.slice(0, 10);
  const dates = new Set<string>();
  if (start !== `${startDate}T00:00:00.000Z`) dates.add(startDate);
  if (reset !== `${endDate}T00:00:00.000Z`) dates.add(endDate);
  if (dates.size === 0) return false;
  const row = await db().queryOne(
    "SELECT 1 FROM daily_team_usage_summary WHERE team_id = $1 AND date = ANY($2::date[]) AND successful_requests > 0 LIMIT 1",
    [teamId, [...dates]]
  );
  return Boolean(row);
}

export async function advanceTeamBudgetWindow(team: Team, nowMs = Date.now()): Promise<Team> {
  if (!team.maxBudgetUsd || !team.budgetDuration || !team.budgetResetAt) return team;
  const durationMs = BUDGET_DURATION_MS[team.budgetDuration];
  let resetAtMs = Date.parse(team.budgetResetAt);
  if (!Number.isFinite(resetAtMs)) throw new Error("Team budget reset metadata is invalid");
  if (resetAtMs > nowMs) return team;
  const elapsedWindows = Math.floor((nowMs - resetAtMs) / durationMs) + 1;
  resetAtMs += elapsedWindows * durationMs;
  const nextReset = new Date(resetAtMs).toISOString();
  const updatedAt = new Date(nowMs).toISOString();
  // Compare-and-set on the old reset instant: only one caller advances a window.
  const result = await db().execute(
    `UPDATE teams
       SET budget_reset_at = $1::timestamptz, updated_at = $2::timestamptz
       WHERE id = $3 AND budget_reset_at = $4::timestamptz`,
    [nextReset, updatedAt, team.id, team.budgetResetAt]
  );
  if (result.changes !== 1) return (await getTeam(team.id)) ?? team;
  invalidateApiKeyPolicyCache();
  return { ...team, budgetResetAt: nextReset, updatedAt };
}

export function getTeamBudgetWindowStart(team: Team): string | null {
  if (!team.budgetDuration || !team.budgetResetAt) return null;
  return new Date(
    Date.parse(team.budgetResetAt) - BUDGET_DURATION_MS[team.budgetDuration]
  ).toISOString();
}
