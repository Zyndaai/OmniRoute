import { randomUUID } from "node:crypto";
import { db, jsonb, ts } from "./pg";
import { registerDbStateResetter } from "./stateReset";

export type ReasoningRuleScope = "global" | "apiKey" | "combo" | "model" | "connection";
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type ReasoningSourceEffort = "any" | "missing" | ReasoningEffort;
export type ReasoningEffortMode = "inherit" | "default" | "force";
export type ReasoningTargetKind = "keep" | "model" | "combo";
export type ReasoningBudgetAction = "preserve" | "remove" | "set";

export interface ReasoningRoutingRule {
  id: string;
  name: string;
  description: string;
  scope: ReasoningRuleScope;
  apiKeyId: string | null;
  comboId: string | null;
  connectionId: string | null;
  modelPattern: string | null;
  sourceEffort: ReasoningSourceEffort;
  requestTags: string[];
  tagMatchMode: "any" | "all";
  effortMode: ReasoningEffortMode;
  targetEffort: ReasoningEffort | null;
  targetKind: ReasoningTargetKind;
  targetModel: string | null;
  targetComboId: string | null;
  budgetAction: ReasoningBudgetAction;
  budgetTokens: number | null;
  priority: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ReasoningRoutingRuleInput = Omit<
  ReasoningRoutingRule,
  "id" | "createdAt" | "updatedAt"
>;

type RuleRow = Record<string, unknown>;
let cache: { version: number; rules: ReasoningRoutingRule[] } | null = null;
let version = 0;

function parseTags(value: unknown): string[] {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed)
      ? [
          ...new Set(
            parsed
              .filter((tag): tag is string => typeof tag === "string")
              .map((tag) => tag.trim().toLowerCase())
              .filter(Boolean)
          ),
        ]
      : [];
  } catch {
    return [];
  }
}

function rowToRule(row: RuleRow): ReasoningRoutingRule {
  return {
    id: String(row.id),
    name: String(row.name),
    description: typeof row.description === "string" ? row.description : "",
    scope: row.scope as ReasoningRuleScope,
    apiKeyId: typeof row.api_key_id === "string" ? row.api_key_id : null,
    comboId: typeof row.combo_id === "string" ? row.combo_id : null,
    connectionId: typeof row.connection_id === "string" ? row.connection_id : null,
    modelPattern: typeof row.model_pattern === "string" ? row.model_pattern : null,
    sourceEffort: row.source_effort as ReasoningSourceEffort,
    requestTags: parseTags(row.request_tags),
    tagMatchMode: row.tag_match_mode === "all" ? "all" : "any",
    effortMode: row.effort_mode as ReasoningEffortMode,
    targetEffort:
      typeof row.target_effort === "string" ? (row.target_effort as ReasoningEffort) : null,
    targetKind: row.target_kind as ReasoningTargetKind,
    targetModel: typeof row.target_model === "string" ? row.target_model : null,
    targetComboId: typeof row.target_combo_id === "string" ? row.target_combo_id : null,
    budgetAction: row.budget_action as ReasoningBudgetAction,
    budgetTokens: typeof row.budget_tokens === "number" ? row.budget_tokens : null,
    priority: typeof row.priority === "number" ? row.priority : 0,
    enabled: row.enabled === 1 || row.enabled === true,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function invalidate(): void {
  version += 1;
  cache = null;
}

const REFERENCE_QUERIES = {
  api_keys: "SELECT 1 AS ok FROM api_keys WHERE id = $1",
  combos: "SELECT 1 AS ok FROM combos WHERE id = $1",
  provider_connections: "SELECT 1 AS ok FROM provider_connections WHERE id = $1",
} as const;

async function referenceExists(
  table: keyof typeof REFERENCE_QUERIES,
  id: string | null
): Promise<boolean> {
  if (!id) return false;
  return Boolean(await db().queryOne(REFERENCE_QUERIES[table], [id]));
}

export async function getReasoningRoutingRuleReferenceErrors(
  rule: ReasoningRoutingRuleInput
): Promise<string[]> {
  const errors: string[] = [];
  if (rule.scope === "apiKey" && !(await referenceExists("api_keys", rule.apiKeyId))) {
    errors.push("The referenced API key does not exist");
  }
  if (rule.scope === "combo" && !(await referenceExists("combos", rule.comboId))) {
    errors.push("The referenced source combo does not exist");
  }
  if (
    rule.scope === "connection" &&
    !(await referenceExists("provider_connections", rule.connectionId))
  ) {
    errors.push("The referenced provider connection does not exist");
  }
  if (rule.targetKind === "combo" && !(await referenceExists("combos", rule.targetComboId))) {
    errors.push("The referenced target combo does not exist");
  }
  return errors;
}

async function assertReferences(rule: ReasoningRoutingRuleInput): Promise<void> {
  const errors = await getReasoningRoutingRuleReferenceErrors(rule);
  if (errors.length > 0) throw new Error(errors.join("; "));
}

export async function getReasoningRoutingRules(
  options: { enabledOnly?: boolean } = {}
): Promise<ReasoningRoutingRule[]> {
  if (!cache || cache.version !== version) {
    const loadedVersion = version;
    const rows = await db().query<RuleRow>(
      "SELECT * FROM reasoning_routing_rules ORDER BY priority DESC, created_at ASC, id ASC"
    );
    // An invalidate() during the query bumped `version`; do not cache stale rows.
    const loaded = { version: loadedVersion, rules: rows.map(rowToRule) };
    if (loadedVersion === version) cache = loaded;
    return filterRules(loaded.rules, options);
  }
  return filterRules(cache.rules, options);
}

function filterRules(
  all: ReasoningRoutingRule[],
  options: { enabledOnly?: boolean }
): ReasoningRoutingRule[] {
  const rules = options.enabledOnly ? all.filter((rule) => rule.enabled) : all;
  return rules.map((rule) => ({ ...rule, requestTags: [...rule.requestTags] }));
}

export async function getReasoningRoutingRuleById(
  id: string
): Promise<ReasoningRoutingRule | null> {
  const row = await db().queryOne<RuleRow>("SELECT * FROM reasoning_routing_rules WHERE id = $1", [
    id,
  ]);
  return row ? rowToRule(row) : null;
}

/** The first 20 bind values shared by INSERT and UPDATE ($1..$20). */
function ruleParams(rule: ReasoningRoutingRuleInput, id: string): unknown[] {
  return [
    id,
    rule.name,
    rule.description || "",
    rule.scope,
    rule.apiKeyId ?? null,
    rule.comboId ?? null,
    rule.connectionId ?? null,
    rule.modelPattern ?? null,
    rule.sourceEffort,
    jsonb(parseTags(rule.requestTags)),
    rule.tagMatchMode,
    rule.effortMode,
    rule.effortMode === "inherit" ? null : rule.targetEffort,
    rule.targetKind,
    rule.targetKind === "model" ? rule.targetModel : null,
    rule.targetKind === "combo" ? rule.targetComboId : null,
    rule.targetEffort === "none" ? "remove" : rule.budgetAction,
    rule.budgetAction === "set" && typeof rule.budgetTokens === "number"
      ? Math.round(rule.budgetTokens)
      : null,
    Math.round(rule.priority),
    Boolean(rule.enabled),
  ];
}

export async function createReasoningRoutingRule(
  rule: ReasoningRoutingRuleInput
): Promise<ReasoningRoutingRule> {
  await assertReferences(rule);
  const id = randomUUID();
  const now = ts(new Date());
  await db().execute(
    `INSERT INTO reasoning_routing_rules (
      id, name, description, scope, api_key_id, combo_id, connection_id, model_pattern,
      source_effort, request_tags, tag_match_mode, effort_mode, target_effort, target_kind,
      target_model, target_combo_id, budget_action, budget_tokens, priority, enabled, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10::jsonb, $11, $12, $13, $14,
      $15, $16, $17, $18, $19, $20, $21::timestamptz, $21::timestamptz
    )`,
    [...ruleParams(rule, id), now]
  );
  invalidate();
  return (await getReasoningRoutingRuleById(id))!;
}

export async function updateReasoningRoutingRule(
  id: string,
  patch: Partial<ReasoningRoutingRuleInput>
): Promise<ReasoningRoutingRule | null> {
  const existing = await getReasoningRoutingRuleById(id);
  if (!existing) return null;
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...base } = existing;
  const next = { ...base, ...patch } as ReasoningRoutingRuleInput;
  await assertReferences(next);
  await db().execute(
    `UPDATE reasoning_routing_rules SET
      name=$2, description=$3, scope=$4, api_key_id=$5,
      combo_id=$6, connection_id=$7, model_pattern=$8,
      source_effort=$9, request_tags=$10::jsonb, tag_match_mode=$11,
      effort_mode=$12, target_effort=$13, target_kind=$14,
      target_model=$15, target_combo_id=$16, budget_action=$17,
      budget_tokens=$18, priority=$19, enabled=$20, updated_at=now()
      WHERE id=$1`,
    ruleParams(next, id)
  );
  invalidate();
  return getReasoningRoutingRuleById(id);
}

export async function deleteReasoningRoutingRule(id: string): Promise<boolean> {
  const result = await db().execute("DELETE FROM reasoning_routing_rules WHERE id = $1", [id]);
  if (result.changes > 0) invalidate();
  return result.changes > 0;
}

export function invalidateReasoningRoutingRuleCache(): void {
  invalidate();
}

registerDbStateResetter(invalidateReasoningRoutingRuleCache);
