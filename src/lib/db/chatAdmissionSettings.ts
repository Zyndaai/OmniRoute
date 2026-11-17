/**
 * chatAdmissionSettings.ts — Tunables for the chat admission controller.
 *
 * The persisted `settings.chatAdmissionSettings` row was dropped with the PostgreSQL move
 * (the module had no runtime caller), so only the env-var path, the defaults and the
 * payload normaliser remain.
 */

export interface ChatAdmissionSettings {
  chatMaxHeavyInFlight: number;
  chatAdmissionHeapShedRatio: number;
  chatAdmissionHealthyHeadroom: number;
}

export type ChatAdmissionSettingKey = keyof ChatAdmissionSettings;
export type ChatAdmissionSettingSource = "env" | "db" | "default";

export const DEFAULT_CHAT_ADMISSION_SETTINGS: ChatAdmissionSettings = {
  chatMaxHeavyInFlight: 1,
  chatAdmissionHeapShedRatio: 0.75,
  chatAdmissionHealthyHeadroom: 1,
};

/**
 * Env var backing each tunable. Presence of a non-blank var is what makes the
 * operator override bind — an explicit `=1` must win over a DB value of `1` too,
 * matching `resolveLegacyCountCap()` in `chatBodyAdmission.ts`.
 */
const ENV_KEYS: Record<ChatAdmissionSettingKey, string> = {
  chatMaxHeavyInFlight: "OMNIROUTE_CHAT_MAX_HEAVY_IN_FLIGHT",
  chatAdmissionHeapShedRatio: "OMNIROUTE_CHAT_ADMISSION_HEAP_SHED_RATIO",
  chatAdmissionHealthyHeadroom: "OMNIROUTE_CHAT_ADMISSION_HEALTHY_HEADROOM",
};

/**
 * Per-field validity predicates, shared by the env and payload paths so the two can
 * never drift.
 */
function isValid(key: ChatAdmissionSettingKey, value: number): boolean {
  switch (key) {
    case "chatMaxHeavyInFlight":
      return Number.isSafeInteger(value) && value >= 1;
    case "chatAdmissionHeapShedRatio":
      return Number.isFinite(value) && value > 0 && value <= 1;
    case "chatAdmissionHealthyHeadroom":
      return Number.isSafeInteger(value) && value >= 0;
  }
}

/**
 * Env parsing mirrors `chatBodyAdmission.ts`: `parseInt` for the integer
 * tunables (so `"5x"` reads as 5), `Number` for the ratio (so `"0.5x"` is
 * rejected rather than silently truncated to 0.5).
 */
function parseSetting(key: ChatAdmissionSettingKey, raw: string): number {
  return key === "chatAdmissionHeapShedRatio" ? Number(raw) : Number.parseInt(raw, 10);
}

function isEnvProvided(key: ChatAdmissionSettingKey): boolean {
  const raw = process.env[ENV_KEYS[key]];
  return raw !== undefined && raw.trim() !== "";
}

/** Env value for one key; the default when unset or malformed. */
function readEnvValue(key: ChatAdmissionSettingKey): number {
  const fallback = DEFAULT_CHAT_ADMISSION_SETTINGS[key];
  if (!isEnvProvided(key)) return fallback;
  const parsed = parseSetting(key, process.env[ENV_KEYS[key]] as string);
  return isValid(key, parsed) ? parsed : fallback;
}

/** A field from an untrusted record, or the default when absent/out-of-range. */
function pickSetting(source: Record<string, unknown>, key: ChatAdmissionSettingKey): number {
  const value = source[key];
  return typeof value === "number" && isValid(key, value)
    ? value
    : DEFAULT_CHAT_ADMISSION_SETTINGS[key];
}

/**
 * Coerce an untrusted settings payload into a fully-validated object. Absent or
 * out-of-range fields fall back to defaults.
 */
export function normalizeChatAdmissionSettings(input: unknown): ChatAdmissionSettings {
  const source =
    input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return {
    chatMaxHeavyInFlight: pickSetting(source, "chatMaxHeavyInFlight"),
    chatAdmissionHeapShedRatio: pickSetting(source, "chatAdmissionHeapShedRatio"),
    chatAdmissionHealthyHeadroom: pickSetting(source, "chatAdmissionHealthyHeadroom"),
  };
}

export function readChatAdmissionSettingsFromEnv(): ChatAdmissionSettings {
  return {
    chatMaxHeavyInFlight: readEnvValue("chatMaxHeavyInFlight"),
    chatAdmissionHeapShedRatio: readEnvValue("chatAdmissionHeapShedRatio"),
    chatAdmissionHealthyHeadroom: readEnvValue("chatAdmissionHealthyHeadroom"),
  };
}
