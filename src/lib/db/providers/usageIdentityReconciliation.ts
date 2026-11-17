import type { DbExecutor } from "../pg";
import { resolveUsageAccountIdentity } from "@/lib/usage/accountIdentity";
import { parseProviderSpecificData } from "../webSessionDedup";
import { toStringOrNull } from "./columns";

type JsonRecord = Record<string, unknown>;

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function isSafeCodexIdentityEnrichment(existing: JsonRecord, merged: JsonRecord): boolean {
  const oldProviderData = parseProviderSpecificData(existing.provider_specific_data) || {};
  const newProviderData = parseProviderSpecificData(merged.providerSpecificData) || {};
  const oldUserId = nonEmptyString(oldProviderData.chatgptUserId);
  const newUserId = nonEmptyString(newProviderData.chatgptUserId);
  const oldWorkspaceId = nonEmptyString(oldProviderData.workspaceId);
  const newWorkspaceId = nonEmptyString(newProviderData.workspaceId);
  const oldEmail = nonEmptyString(existing.email);
  const newEmail = nonEmptyString(merged.email);

  return (
    toStringOrNull(existing.provider) === "codex" &&
    toStringOrNull(existing.auth_type) === "oauth" &&
    toStringOrNull(merged.provider) === "codex" &&
    toStringOrNull(merged.authType) === "oauth" &&
    oldUserId === null &&
    newUserId !== null &&
    (oldWorkspaceId === null || oldWorkspaceId === newWorkspaceId) &&
    (oldEmail === null || oldEmail === newEmail)
  );
}

/**
 * Reconcile usage-history identity after a Codex connection gains its stable
 * user identity. The caller invokes this inside the same transaction as the
 * provider row update, so history and connection identity cannot diverge.
 */
export async function reconcileCodexUsageHistory(
  tx: DbExecutor,
  input: {
    connectionId: string;
    existing: JsonRecord;
    merged: JsonRecord;
    matchedExistingCodexByWorkspace?: boolean;
  }
): Promise<void> {
  const oldIdentity = resolveUsageAccountIdentity(input.existing);
  const newIdentity = resolveUsageAccountIdentity(input.merged);
  const identityChanged = oldIdentity.accountKey !== newIdentity.accountKey;
  const permitted =
    input.matchedExistingCodexByWorkspace === true ||
    isSafeCodexIdentityEnrichment(input.existing, input.merged);

  if (!identityChanged || !permitted) return;

  await tx.execute(
    `UPDATE usage_history
     SET account_key = $1::text,
         account_label = CASE
           WHEN $2::integer > COALESCE(account_label_priority, 0)
           THEN $3::text
           ELSE account_label
         END,
         account_label_priority = GREATEST(
           COALESCE(account_label_priority, 0),
           $2::integer
         )
     WHERE connection_id = $4
       AND account_key = $5`,
    [
      newIdentity.accountKey,
      newIdentity.accountLabelPriority,
      newIdentity.accountLabel,
      input.connectionId,
      oldIdentity.accountKey,
    ]
  );
}
