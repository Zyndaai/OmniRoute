import { db } from "./pg";

export interface RootLayoutSettings {
  instanceName: string;
  customFaviconUrl: string;
  customFaviconBase64: string;
}

type RootLayoutSettingKey = keyof RootLayoutSettings;

const ROOT_LAYOUT_SETTING_KEYS = [
  "instanceName",
  "customFaviconUrl",
  "customFaviconBase64",
] as const satisfies readonly RootLayoutSettingKey[];

const ROOT_LAYOUT_SETTING_KEY_SET = new Set<string>(ROOT_LAYOUT_SETTING_KEYS);

const DEFAULT_ROOT_LAYOUT_SETTINGS: RootLayoutSettings = {
  instanceName: "OmniRoute",
  customFaviconUrl: "",
  customFaviconBase64: "",
};

/** Read only the settings the root layout renders (instance name and favicon). */
export async function getRootLayoutSettings(): Promise<RootLayoutSettings> {
  const settings = { ...DEFAULT_ROOT_LAYOUT_SETTINGS };

  let rows: Array<{ key: string; value: unknown }>;
  try {
    rows = await db().query<{ key: string; value: unknown }>(
      "SELECT key, value FROM config_entries WHERE namespace = 'settings' AND key = ANY($1::text[])",
      [[...ROOT_LAYOUT_SETTING_KEYS]]
    );
  } catch {
    return settings;
  }

  for (const row of rows) {
    if (!ROOT_LAYOUT_SETTING_KEY_SET.has(row.key) || typeof row.value !== "string") continue;
    settings[row.key as RootLayoutSettingKey] = row.value;
  }

  if (!settings.instanceName) settings.instanceName = DEFAULT_ROOT_LAYOUT_SETTINGS.instanceName;
  return settings;
}
