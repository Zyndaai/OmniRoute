/**
 * Row writers for `proxy_subscriptions`.
 */
import { jsonb, type DbExecutor } from "@/lib/db/pg";
import { stripNul } from "@/lib/db/proxies/sanitize";
import { encodeMirrorUrls } from "./mirrorUrls";

/** The column is an integer with CHECK > 0; the schema layer lets any number through. */
function clampIntervalMinutes(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.round(value)) : 60;
}

export interface SubscriptionRowValues {
  id: string;
  name: string;
  url: string;
  mirrorUrls: string[] | null;
  enabled: boolean;
  mode: string;
  ruleProviders: string[] | null;
  localCoreEndpoint: string | null;
  updateIntervalMinutes: number;
  controlUrl: string | null;
  coreConfigPath: string | null;
  gapSeconds: number;
  now: string;
}

/** INSERT a subscription row. `executor` is `db()` or a transaction's `tx`. */
export async function insertSubscriptionRow(
  executor: DbExecutor,
  row: SubscriptionRowValues & { controlSecretEnc: string | null }
): Promise<void> {
  await executor.execute(
    `INSERT INTO proxy_subscriptions
      (id, name, url, mirror_urls, enabled, mode, rule_providers, local_core_endpoint, update_interval_minutes, control_url, core_config_path, control_secret_enc, selector_min_gap_seconds, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, 'empty', $14, $14)`,
    [
      row.id,
      stripNul(row.name),
      stripNul(row.url),
      encodeMirrorUrls(row.mirrorUrls),
      row.enabled,
      row.mode,
      jsonb(row.ruleProviders),
      row.localCoreEndpoint || null,
      clampIntervalMinutes(row.updateIntervalMinutes),
      row.controlUrl,
      row.coreConfigPath,
      row.controlSecretEnc,
      row.gapSeconds,
      row.now,
    ]
  );
}

export interface SubscriptionUpdateValues extends SubscriptionRowValues {
  controlSecretEnc: string | null | undefined;
}

/**
 * UPDATE a subscription row. `control_secret_enc` is written only when
 * `controlSecretEnc` is not undefined (write-only secret: absent leaves it).
 */
export async function updateSubscriptionRow(
  executor: DbExecutor,
  row: SubscriptionUpdateValues
): Promise<void> {
  const params: unknown[] = [
    stripNul(row.name),
    stripNul(row.url),
    encodeMirrorUrls(row.mirrorUrls),
    row.enabled,
    row.mode,
    jsonb(row.ruleProviders),
    row.localCoreEndpoint || null,
    clampIntervalMinutes(row.updateIntervalMinutes),
    row.controlUrl,
    row.coreConfigPath,
  ];
  let secretSet = "";
  if (row.controlSecretEnc !== undefined) {
    params.push(row.controlSecretEnc);
    secretSet = `control_secret_enc = $${params.length}, `;
  }
  params.push(row.gapSeconds, row.now, row.id);
  const n = params.length;
  await executor.execute(
    `UPDATE proxy_subscriptions
        SET name = $1, url = $2, mirror_urls = $3, enabled = $4, mode = $5, rule_providers = $6::jsonb,
            local_core_endpoint = $7, update_interval_minutes = $8, control_url = $9, core_config_path = $10,
            ${secretSet}selector_min_gap_seconds = $${n - 2}, updated_at = $${n - 1}
      WHERE id = $${n}`,
    params
  );
}
