import { db } from "./pg";
import { configJson, deleteConfigValue, getConfigValue } from "./configEntries";
import { decrypt, encrypt } from "./encryption";

const NOTION_NAMESPACE = "notion";
const NOTION_TOKEN_KEY = "integration_token";

export async function getNotionToken(): Promise<string | null> {
  try {
    const stored = await getConfigValue(NOTION_NAMESPACE, NOTION_TOKEN_KEY);
    if (typeof stored !== "string") return null;
    // decrypt() returns plaintext rows (written before tokens were encrypted) unchanged.
    const token = decrypt(stored);
    return typeof token === "string" ? token : null;
  } catch {
    return null;
  }
}

/** First writer wins: an existing token is kept until `clearNotionToken` removes it. */
export async function setNotionToken(token: string): Promise<void> {
  try {
    await db().execute(
      `INSERT INTO config_entries (namespace, key, value) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (namespace, key) DO NOTHING`,
      [NOTION_NAMESPACE, NOTION_TOKEN_KEY, configJson(encrypt(token) ?? token)]
    );
  } catch {
    // Non-fatal — token still works in-memory if persistence fails.
  }
}

export async function clearNotionToken(): Promise<void> {
  try {
    await deleteConfigValue(NOTION_NAMESPACE, NOTION_TOKEN_KEY);
  } catch {
    // Non-fatal.
  }
}

export async function getNotionConfig(): Promise<{ token: string | null; connected: boolean }> {
  const token = await getNotionToken();
  return { token, connected: token !== null && token.length > 0 };
}
