import test from "node:test";
import assert from "node:assert/strict";

// The persisted `settings.chatAdmissionSettings` row (update/reset/read-from-DB/source)
// was dropped with the PostgreSQL move: the module has no runtime caller for it. Only the
// env-var path, the defaults and the payload normaliser remain, so these cases cover those.

const settings = await import("../../src/lib/db/chatAdmissionSettings.ts");

const ENV_NAMES = [
  "OMNIROUTE_CHAT_MAX_HEAVY_IN_FLIGHT",
  "OMNIROUTE_CHAT_ADMISSION_HEAP_SHED_RATIO",
  "OMNIROUTE_CHAT_ADMISSION_HEALTHY_HEADROOM",
] as const;

const DEFAULTS = settings.DEFAULT_CHAT_ADMISSION_SETTINGS;

function clearEnvOverrides() {
  for (const name of ENV_NAMES) delete process.env[name];
}

test.beforeEach(() => {
  clearEnvOverrides();
});

test.after(() => {
  clearEnvOverrides();
});

test("readers fall back to defaults when no env value is set", () => {
  assert.deepEqual(settings.readChatAdmissionSettingsFromEnv(), DEFAULTS);
});

test("normalizeChatAdmissionSettings fills defaults for non-object input", () => {
  assert.deepEqual(settings.normalizeChatAdmissionSettings(null), DEFAULTS);
  assert.deepEqual(settings.normalizeChatAdmissionSettings("nope"), DEFAULTS);
});

test("env parsing accepts valid values per field", () => {
  process.env.OMNIROUTE_CHAT_MAX_HEAVY_IN_FLIGHT = "6";
  process.env.OMNIROUTE_CHAT_ADMISSION_HEAP_SHED_RATIO = "0.5";
  process.env.OMNIROUTE_CHAT_ADMISSION_HEALTHY_HEADROOM = "0";

  assert.deepEqual(settings.readChatAdmissionSettingsFromEnv(), {
    chatMaxHeavyInFlight: 6,
    chatAdmissionHeapShedRatio: 0.5,
    chatAdmissionHealthyHeadroom: 0,
  });
});

test("env parsing rejects malformed values per field without discarding valid siblings", () => {
  // chatMaxHeavyInFlight requires a safe integer >= 1: "Infinity" is invalid.
  process.env.OMNIROUTE_CHAT_MAX_HEAVY_IN_FLIGHT = "Infinity";
  // The ratio keeps the runtime constant's strict rule: "1.2" is outside (0, 1].
  process.env.OMNIROUTE_CHAT_ADMISSION_HEAP_SHED_RATIO = "1.2";
  process.env.OMNIROUTE_CHAT_ADMISSION_HEALTHY_HEADROOM = "5";

  assert.deepEqual(settings.readChatAdmissionSettingsFromEnv(), {
    chatMaxHeavyInFlight: DEFAULTS.chatMaxHeavyInFlight,
    chatAdmissionHeapShedRatio: DEFAULTS.chatAdmissionHeapShedRatio,
    chatAdmissionHealthyHeadroom: 5,
  });
});

test("env parsing treats blank values as unset", () => {
  process.env.OMNIROUTE_CHAT_MAX_HEAVY_IN_FLIGHT = "   ";
  process.env.OMNIROUTE_CHAT_ADMISSION_HEAP_SHED_RATIO = "";
  process.env.OMNIROUTE_CHAT_ADMISSION_HEALTHY_HEADROOM = "   ";

  assert.deepEqual(settings.readChatAdmissionSettingsFromEnv(), DEFAULTS);
});

test("env ratio boundary: 1 is accepted, 0 is rejected", () => {
  process.env.OMNIROUTE_CHAT_ADMISSION_HEAP_SHED_RATIO = "1";
  assert.equal(settings.readChatAdmissionSettingsFromEnv().chatAdmissionHeapShedRatio, 1);

  process.env.OMNIROUTE_CHAT_ADMISSION_HEAP_SHED_RATIO = "0";
  assert.equal(
    settings.readChatAdmissionSettingsFromEnv().chatAdmissionHeapShedRatio,
    DEFAULTS.chatAdmissionHeapShedRatio
  );
});

test("env parsing mirrors the runtime parser for the integer tunables", () => {
  // chatBodyAdmission.ts resolves these with parseInt, so "2.5" reads as 2 there too.
  process.env.OMNIROUTE_CHAT_MAX_HEAVY_IN_FLIGHT = "2.5";
  assert.equal(settings.readChatAdmissionSettingsFromEnv().chatMaxHeavyInFlight, 2);
});
