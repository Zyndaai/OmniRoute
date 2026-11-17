import { db } from "@/lib/db/pg";
import { decrypt, encrypt } from "./encryption";

export interface ApiKeyContextSource {
  apiKeyId: string;
  sourceType: string;
  token: string | null;
  baseUrl: string | null;
  vaultPath: string | null;
  enabled: boolean;
}

interface ContextSourceRow {
  api_key_id: string;
  source_type: string;
  token: string | null;
  base_url: string | null;
  vault_path: string | null;
  enabled: boolean;
}

function rowToSource(row: ContextSourceRow): ApiKeyContextSource {
  return {
    apiKeyId: row.api_key_id,
    sourceType: row.source_type,
    // The token is stored as an enc:v1 envelope; plaintext rows from older writers pass through.
    token: (decrypt(row.token) as string | null | undefined) ?? null,
    baseUrl: row.base_url,
    vaultPath: row.vault_path,
    enabled: row.enabled === true,
  };
}

export async function getApiKeyContextSource(
  apiKeyId: string | null | undefined,
  sourceType: string
): Promise<(ApiKeyContextSource & { enabled: true }) | null> {
  if (!apiKeyId) return null;
  const row = await db().queryOne<ContextSourceRow>(
    "SELECT * FROM api_key_context_sources WHERE api_key_id = $1 AND source_type = $2 AND enabled = true",
    [apiKeyId, sourceType]
  );
  if (!row) return null;
  return rowToSource(row) as ApiKeyContextSource & { enabled: true };
}

export async function setApiKeyContextSource(
  apiKeyId: string,
  sourceType: string,
  config: { token?: string; baseUrl?: string; vaultPath?: string; enabled?: boolean }
): Promise<void> {
  const token = config.token === undefined ? null : (encrypt(config.token) ?? null);
  // Insert defaults a missing `enabled` to true; an update keeps the stored value.
  await db().execute(
    `INSERT INTO api_key_context_sources
        (api_key_id, source_type, token, base_url, vault_path, enabled, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, COALESCE($6::boolean, true), now(), now())
      ON CONFLICT (api_key_id, source_type) DO UPDATE SET
        token = COALESCE($3, api_key_context_sources.token),
        base_url = COALESCE($4, api_key_context_sources.base_url),
        vault_path = COALESCE($5, api_key_context_sources.vault_path),
        enabled = COALESCE($6::boolean, api_key_context_sources.enabled),
        updated_at = now()`,
    [
      apiKeyId,
      sourceType,
      token,
      config.baseUrl ?? null,
      config.vaultPath ?? null,
      config.enabled === undefined ? null : config.enabled,
    ]
  );
}

export async function deleteApiKeyContextSource(
  apiKeyId: string,
  sourceType: string
): Promise<void> {
  await db().execute(
    "DELETE FROM api_key_context_sources WHERE api_key_id = $1 AND source_type = $2",
    [apiKeyId, sourceType]
  );
}

export async function listApiKeyContextSources(apiKeyId: string): Promise<ApiKeyContextSource[]> {
  const rows = await db().query<ContextSourceRow>(
    "SELECT * FROM api_key_context_sources WHERE api_key_id = $1",
    [apiKeyId]
  );
  return rows.map(rowToSource);
}
