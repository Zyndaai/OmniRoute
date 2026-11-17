/**
 * SSO identity ↔ shadow API key binding.
 *
 * An Entra user authenticating to /v1/* is backed by a "shadow" api_keys row.
 * That indirection is the design: key_group_members has a FOREIGN KEY to
 * api_keys(id), so binding SSO users to a real key row means the existing
 * policy engine (rate limits, model allowlists, budgets, combos) and call-log
 * attribution apply unchanged, instead of every one of those paths needing an
 * SSO branch.
 *
 * The shadow key's secret is never issued to anyone — it exists to satisfy the
 * NOT NULL UNIQUE `key` column and the hash lookup in getApiKeyMetadata. The
 * user's actual credential is their Entra token.
 */

import { db, jsonb } from "@/lib/db/pg";
import { createApiKey, deleteApiKey } from "./apiKeys";
import { addKeyToGroup, getKeyGroupsForApiKey, removeKeyFromGroup } from "./apiKeyGroups";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import * as log from "@/sse/utils/logger";

export interface SsoIdentityRecord {
  oid: string;
  tenantId: string;
  upn: string;
  displayName: string;
  apiKeyId: string;
  lastGroups: string[];
  lastSeenAt: string | null;
  createdAt: string;
}

interface SsoIdentityRow {
  oid?: unknown;
  tenant_id?: unknown;
  upn?: unknown;
  display_name?: unknown;
  api_key_id?: unknown;
  last_groups?: unknown;
  last_seen_at?: unknown;
  created_at?: unknown;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseGroups(value: unknown): string[] {
  // jsonb arrives parsed; a legacy JSON string is still tolerated.
  let parsed: unknown = value;
  if (typeof value === "string") {
    if (value.length === 0) return [];
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

function rowToRecord(row: SsoIdentityRow): SsoIdentityRecord {
  return {
    oid: str(row.oid),
    tenantId: str(row.tenant_id),
    upn: str(row.upn),
    displayName: str(row.display_name),
    apiKeyId: str(row.api_key_id),
    lastGroups: parseGroups(row.last_groups),
    lastSeenAt: typeof row.last_seen_at === "string" ? row.last_seen_at : null,
    createdAt: str(row.created_at),
  };
}

export async function getSsoIdentity(oid: string): Promise<SsoIdentityRecord | null> {
  if (!oid) return null;
  const row = await db().queryOne<SsoIdentityRow>("SELECT * FROM sso_identities WHERE oid = $1", [
    oid,
  ]);
  return row ? rowToRecord(row) : null;
}

/**
 * Returns null once the shadow key is deactivated, which is the instant
 * kill-switch for an SSO user: revoking them in Entra only stops new tokens,
 * while an already-issued one stays valid until it expires.
 */
export async function getSsoShadowSecret(oid: string): Promise<string | null> {
  if (!oid) return null;
  const row = await db().queryOne<{ key?: unknown }>(
    `SELECT k.key AS key FROM sso_identities s
       INNER JOIN api_keys k ON k.id = s.api_key_id
       WHERE s.oid = $1 AND k.is_active = true AND k.is_banned = false AND k.revoked_at IS NULL`,
    [oid]
  );
  const secret = str(row?.key);
  return secret.length > 0 ? secret : null;
}

async function touchLastSeen(oid: string, keyGroupIds: string[]): Promise<void> {
  await db().execute(
    "UPDATE sso_identities SET last_seen_at = $1, last_groups = $2::jsonb WHERE oid = $3",
    [new Date().toISOString(), jsonb(keyGroupIds), oid]
  );
}

async function markKeyAsSso(apiKeyId: string): Promise<void> {
  await db().execute("UPDATE api_keys SET source = 'sso' WHERE id = $1", [apiKeyId]);
}

export async function setSsoKeyActive(apiKeyId: string, active: boolean): Promise<boolean> {
  const result = await db().execute("UPDATE api_keys SET is_active = $1 WHERE id = $2", [
    active,
    apiKeyId,
  ]);
  return (result.changes ?? 0) > 0;
}

/** Skips all writes when the resolved set matches `previous`, the common case. */
export async function reconcileKeyGroups(
  apiKeyId: string,
  desired: string[],
  previous: string[]
): Promise<boolean> {
  const desiredSet = new Set(desired);
  const previousSet = new Set(previous);

  const sameSize = desiredSet.size === previousSet.size;
  if (sameSize && [...desiredSet].every((id) => previousSet.has(id))) return false;

  for (const groupId of desiredSet) {
    if (!previousSet.has(groupId)) await addKeyToGroup(apiKeyId, groupId);
  }
  for (const groupId of previousSet) {
    if (!desiredSet.has(groupId)) await removeKeyFromGroup(apiKeyId, groupId);
  }
  return true;
}

/** Zero groups means unrestricted downstream, so it is never an acceptable end state. */
async function hasLiveGroupMembership(apiKeyId: string): Promise<boolean> {
  return (await getKeyGroupsForApiKey(apiKeyId)).length > 0;
}

export interface ProvisionInput {
  oid: string;
  tenantId: string;
  upn: string;
  displayName: string;
  keyGroupIds: string[];
}

/**
 * Idempotent under concurrency: two simultaneous first requests both mint a key
 * row, then race on `INSERT OR IGNORE` — one wins and the loser deletes the key
 * it just created rather than leaving an orphan behind.
 */
export async function provisionSsoIdentity(input: ProvisionInput): Promise<string | null> {
  const existing = await getSsoIdentity(input.oid);
  if (existing) {
    await reconcileKeyGroups(existing.apiKeyId, input.keyGroupIds, existing.lastGroups);
    await touchLastSeen(input.oid, input.keyGroupIds);
    if (!(await hasLiveGroupMembership(existing.apiKeyId))) {
      await setSsoKeyActive(existing.apiKeyId, false);
      log.error("ENTRA_SSO", "Shadow key lost every key group — deactivated", {
        oid: input.oid,
        apiKeyId: existing.apiKeyId,
        requested: input.keyGroupIds,
      });
      return null;
    }
    return await getSsoShadowSecret(input.oid);
  }

  const machineId = (await getConsistentMachineId().catch(() => null)) || "0000000000000000";
  const label = input.upn || input.oid;
  const created = await createApiKey(`sso:${label}`, machineId, []);

  const inserted = await db().execute(
    `INSERT INTO sso_identities
         (oid, tenant_id, upn, display_name, api_key_id, last_groups, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())
       ON CONFLICT (oid) DO NOTHING`,
    [input.oid, input.tenantId, input.upn, input.displayName, created.id, jsonb([])]
  );

  if ((inserted.changes ?? 0) === 0) {
    await deleteApiKey(created.id).catch((error: unknown) => {
      log.error("ENTRA_SSO", "Failed to clean up orphaned shadow key after provisioning race", {
        error,
      });
    });
    const winner = await getSsoIdentity(input.oid);
    if (!winner) return null;
    await reconcileKeyGroups(winner.apiKeyId, input.keyGroupIds, winner.lastGroups);
    await touchLastSeen(input.oid, input.keyGroupIds);
    return await getSsoShadowSecret(input.oid);
  }

  await markKeyAsSso(created.id);
  await reconcileKeyGroups(created.id, input.keyGroupIds, []);
  await touchLastSeen(input.oid, input.keyGroupIds);

  if (!(await hasLiveGroupMembership(created.id))) {
    // addKeyToGroup swallows failures, and a key in zero groups is read as
    // unrestricted by checkKeyModelAccess. Deactivate rather than hand out a
    // key with more access than the operator configured.
    await setSsoKeyActive(created.id, false);
    log.error("ENTRA_SSO", "Shadow key landed in no key group — deactivated", {
      oid: input.oid,
      apiKeyId: created.id,
      requested: input.keyGroupIds,
    });
    return null;
  }

  log.info("ENTRA_SSO", "Provisioned shadow API key for SSO user", {
    oid: input.oid,
    apiKeyId: created.id,
    keyGroups: input.keyGroupIds.length,
  });

  return await getSsoShadowSecret(input.oid);
}
