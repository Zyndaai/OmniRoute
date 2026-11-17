import { getApiKeyContextSource } from "./apiKeyContextSources";
import { deleteConfigValue, getConfigValue, setConfigValue } from "./configEntries";
import { encrypt, decrypt } from "./encryption";

const OBSIDIAN_NAMESPACE = "obsidian";
const OBSIDIAN_TOKEN_KEY = "api_key";
const DEFAULT_BASE_URL = "http://127.0.0.1:27123";

/** A stored non-empty string, or null (missing row, other type, or any storage error). */
async function readString(key: string): Promise<string | null> {
  try {
    const value = await getConfigValue(OBSIDIAN_NAMESPACE, key);
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Persistence is best-effort: the value still works in-memory if the write fails. */
async function writeValue(key: string, value: unknown): Promise<void> {
  try {
    await setConfigValue(OBSIDIAN_NAMESPACE, key, value);
  } catch {
    // Non-fatal.
  }
}

async function clearValue(key: string): Promise<void> {
  try {
    await deleteConfigValue(OBSIDIAN_NAMESPACE, key);
  } catch {
    // Non-fatal.
  }
}

export async function getObsidianToken(): Promise<string | null> {
  const stored = await readString(OBSIDIAN_TOKEN_KEY);
  if (stored === null) return null;
  // Graceful fallback: if decrypt fails (e.g. no key set) return as-is
  return decrypt(stored) ?? stored;
}

export async function setObsidianToken(token: string): Promise<void> {
  await writeValue(OBSIDIAN_TOKEN_KEY, encrypt(token) ?? token);
}

export async function clearObsidianToken(): Promise<void> {
  await clearValue(OBSIDIAN_TOKEN_KEY);
}

export async function getObsidianBaseUrl(): Promise<string> {
  return (await readString("base_url")) ?? DEFAULT_BASE_URL;
}

export async function setObsidianBaseUrl(url: string): Promise<void> {
  await writeValue("base_url", url);
}

export async function clearObsidianBaseUrl(): Promise<void> {
  await clearValue("base_url");
}

export async function getObsidianVaultPath(): Promise<string | null> {
  return readString("vault_path");
}

export async function setObsidianVaultPath(vaultPath: string): Promise<void> {
  await writeValue("vault_path", vaultPath);
}

export async function clearObsidianVaultPath(): Promise<void> {
  await clearValue("vault_path");
}

export async function getWebdavUsername(): Promise<string | null> {
  return readString("webdav_username");
}

export async function setWebdavUsername(username: string): Promise<void> {
  await writeValue("webdav_username", username);
}

export async function clearWebdavUsername(): Promise<void> {
  await clearValue("webdav_username");
}

export async function getWebdavPassword(): Promise<string | null> {
  const stored = await readString("webdav_password");
  if (stored === null) return null;
  // Graceful fallback: if decrypt fails return as-is (plaintext backward compat)
  return decrypt(stored) ?? stored;
}

export async function setWebdavPassword(password: string): Promise<void> {
  await writeValue("webdav_password", encrypt(password) ?? password);
}

export async function clearWebdavPassword(): Promise<void> {
  await clearValue("webdav_password");
}

export async function getWebdavEnabled(): Promise<boolean> {
  try {
    return (await getConfigValue(OBSIDIAN_NAMESPACE, "webdav_enabled")) === true;
  } catch {
    return false;
  }
}

export async function setWebdavEnabled(enabled: boolean): Promise<void> {
  await writeValue("webdav_enabled", enabled);
}

export async function clearWebdavEnabled(): Promise<void> {
  await clearValue("webdav_enabled");
}

export async function getObsidianConfig(): Promise<{
  token: string | null;
  connected: boolean;
  baseUrl: string;
  vaultPath: string | null;
}> {
  const token = await getObsidianToken();
  const baseUrl = await getObsidianBaseUrl();
  const vaultPath = await getObsidianVaultPath();
  return { token, connected: token !== null && token.length > 0, baseUrl, vaultPath };
}

export async function getObsidianConfigForApiKey(apiKeyId: string | null | undefined): Promise<{
  token: string | null;
  baseUrl: string;
  vaultPath: string | null;
  source: "api_key" | "global";
}> {
  if (apiKeyId) {
    try {
      const perKey = await getApiKeyContextSource(apiKeyId, "obsidian");
      if (perKey && perKey.enabled && perKey.token) {
        return {
          token: perKey.token,
          baseUrl: perKey.baseUrl || (await getObsidianBaseUrl()),
          vaultPath: perKey.vaultPath || (await getObsidianVaultPath()),
          source: "api_key",
        };
      }
    } catch {
      // Per-key config not available — fall through to global
    }
  }
  return {
    token: await getObsidianToken(),
    baseUrl: await getObsidianBaseUrl(),
    vaultPath: await getObsidianVaultPath(),
    source: "global",
  };
}
