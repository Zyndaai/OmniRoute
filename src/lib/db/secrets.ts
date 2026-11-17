import { db } from "./pg";
import { configJson, getConfigValue } from "./configEntries";
import { decrypt, encrypt } from "./encryption";

export async function getPersistedSecret(key: string): Promise<string | null> {
  try {
    const stored = await getConfigValue("secrets", key);
    if (typeof stored !== "string") return null;
    // SECURITY: JWT_SECRET / API_KEY_SECRET are persisted via encrypt() below.
    // decrypt() transparently returns plaintext unchanged when the stored
    // value does not carry the `enc:v1:` prefix (pre-existing rows written
    // before this fix, or STORAGE_ENCRYPTION_KEY passthrough mode).
    const decrypted = decrypt(stored);
    return typeof decrypted === "string" ? decrypted : null;
  } catch {
    return null;
  }
}

/** First writer wins, so concurrent processes converge on one persisted secret. */
export async function persistSecret(key: string, value: string): Promise<void> {
  try {
    // SECURITY: encrypt with the project's AES-256-GCM field-encryption
    // helper before writing — matches the calling convention used for provider
    // credentials. Falls back to plaintext passthrough only when
    // STORAGE_ENCRYPTION_KEY is not configured (encrypt()'s own behavior).
    const toStore = encrypt(value);
    await db().execute(
      `INSERT INTO config_entries (namespace, key, value) VALUES ('secrets', $1, $2::jsonb)
       ON CONFLICT (namespace, key) DO NOTHING`,
      [key, configJson(toStore ?? value)]
    );
  } catch {
    // Non-fatal: secrets still work for the current process if persistence fails.
  }
}
