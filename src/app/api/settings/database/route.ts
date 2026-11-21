import { z } from "zod";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { databaseSettingsSchema } from "@/shared/validation/settingsSchemas";
import { getDatabaseSettingsSection } from "@/lib/db/databaseSettingsSections";
import { setConfigValue } from "@/lib/db/configEntries";
import { updateSettings } from "@/lib/db/settings";
import { invalidateDbCache } from "@/lib/db/readCache";
import {
  CACHE_SECRET_MASK,
  assertCacheCredentialEndpoint,
  encryptCacheValue,
  isCacheSecret,
  redactCacheSecrets,
} from "@/lib/db/cacheSecrets";
import type { DatabaseSettings } from "@/types/databaseSettings";

type UserDatabaseSettings = Omit<DatabaseSettings, "location" | "stats">;

// Backup and optimization settings were SQLite-file concerns and are no longer persisted.
const PERSISTED_SECTIONS = ["logs", "cache", "retention", "aggregation"] as const;
const READ_SECTIONS = [...PERSISTED_SECTIONS, "backup", "optimization"] as const;

async function publicDatabaseSettings() {
  const entries = await Promise.all(
    READ_SECTIONS.map(async (section) => [section, await getDatabaseSettingsSection(section)] as const)
  );
  const settings = Object.fromEntries(entries) as UserDatabaseSettings;
  return { ...settings, cache: redactCacheSecrets(settings.cache) };
}

const databaseSettingsPatchSchema = z
  .object({
    logs: databaseSettingsSchema.shape.logs.partial(),
    backup: databaseSettingsSchema.shape.backup.partial(),
    cache: databaseSettingsSchema.shape.cache.partial(),
    retention: databaseSettingsSchema.shape.retention.partial(),
    aggregation: databaseSettingsSchema.shape.aggregation.partial(),
    optimization: databaseSettingsSchema.shape.optimization.partial(),
  })
  .partial()
  .strict();

async function updateDatabaseSettings(updates: Partial<UserDatabaseSettings>) {
  if (updates.cache) {
    const currentCache = await getDatabaseSettingsSection("cache");
    assertCacheCredentialEndpoint(
      currentCache as unknown as Record<string, unknown>,
      updates.cache as Record<string, unknown>
    );
  }

  for (const section of PERSISTED_SECTIONS) {
    const sectionUpdate = updates[section] as Record<string, unknown> | undefined;
    if (!sectionUpdate) continue;
    for (const [key, value] of Object.entries(sectionUpdate)) {
      if (section === "cache" && isCacheSecret(key) && value === CACHE_SECRET_MASK) continue;
      const stored = section === "cache" ? encryptCacheValue(key, value) : value;
      await setConfigValue("databaseSettings", `${section}.${key}`, stored);
    }
  }

  const pipelineEnabled = updates.logs?.callLogPipelineEnabled;
  if (pipelineEnabled !== undefined) {
    await updateSettings({ call_log_pipeline_enabled: Boolean(pipelineEnabled) });
  }
  invalidateDbCache("settings");
}

export async function GET(request: Request) {
  if (!(await isAuthenticated(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return Response.json(await publicDatabaseSettings());
  } catch (error) {
    console.error("Error getting database settings:", error);
    return Response.json({ error: "Failed to load database settings" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  if (!(await isAuthenticated(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const rawBody = await request.json();
    const validation = validateBody(databaseSettingsPatchSchema, rawBody);

    if (isValidationFailure(validation)) {
      return Response.json({ error: validation.error }, { status: 400 });
    }

    await updateDatabaseSettings(validation.data as Partial<UserDatabaseSettings>);

    // Return merged settings (GET response pattern)
    return Response.json(await publicDatabaseSettings());
  } catch (error) {
    console.error("Error updating database settings:", error);
    return Response.json({ error: "Failed to update database settings" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  return PATCH(request);
}
