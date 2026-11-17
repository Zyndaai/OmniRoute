import { db } from "@/lib/db/pg";
import { encrypt, decrypt } from "@/lib/db/encryption";
import type { AgentCredentials } from "@/lib/cloudAgent/baseAgent";

// The `cloud_agent_credentials` table is part of the PostgreSQL schema
// (migrations/0001_init.sql). Do not create it inline here.

/** Mask API key for display — show last 4 chars only */
export function maskApiKey(key: string): string {
  if (!key || key.length <= 4) return "****";
  return "****" + key.slice(-4);
}

/** Get decrypted credentials for a provider */
export async function getCloudAgentCredentialFromDb(
  providerId: string
): Promise<AgentCredentials | null> {
  const row = await db().queryOne<{ api_key_encrypted: string; base_url: string | null }>(
    "SELECT api_key_encrypted, base_url FROM cloud_agent_credentials WHERE provider_id = $1",
    [providerId]
  );

  if (!row) return null;

  const decryptedKey = decrypt(row.api_key_encrypted);
  if (!decryptedKey) return null;

  const creds: AgentCredentials = { apiKey: decryptedKey };
  if (row.base_url) creds.baseUrl = row.base_url;
  return creds;
}

/** List all credentials with masked keys */
export async function listCloudAgentCredentials(): Promise<
  Array<{
    providerId: string;
    apiKey: string;
    baseUrl: string | null;
    updatedAt: string;
  }>
> {
  const rows = await db().query<{
    provider_id: string;
    api_key_encrypted: string;
    base_url: string | null;
    updated_at: string;
  }>("SELECT provider_id, api_key_encrypted, base_url, updated_at FROM cloud_agent_credentials");

  return rows.map((row) => {
    const decrypted = decrypt(row.api_key_encrypted) ?? "";
    return {
      providerId: row.provider_id,
      apiKey: maskApiKey(decrypted),
      baseUrl: row.base_url,
      updatedAt: row.updated_at,
    };
  });
}

/** Save or update credentials (encrypts API key at rest) */
export async function saveCloudAgentCredential(
  providerId: string,
  apiKey: string,
  baseUrl?: string
): Promise<void> {
  const encrypted = encrypt(apiKey);
  if (!encrypted) throw new Error("Failed to encrypt API key");

  await db().execute(
    `INSERT INTO cloud_agent_credentials (provider_id, api_key_encrypted, base_url, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (provider_id) DO UPDATE SET
       api_key_encrypted = EXCLUDED.api_key_encrypted,
       base_url = EXCLUDED.base_url,
       updated_at = EXCLUDED.updated_at`,
    [providerId, encrypted, baseUrl ?? null]
  );
}

/** Delete credentials for a provider */
export async function deleteCloudAgentCredential(providerId: string): Promise<void> {
  await db().execute("DELETE FROM cloud_agent_credentials WHERE provider_id = $1", [providerId]);
}
