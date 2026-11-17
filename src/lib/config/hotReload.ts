import { getSettings } from "@/lib/db/settings";
import { applyRuntimeSettings, type RuntimeReloadChange } from "./runtimeSettings";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MIN_POLL_INTERVAL_MS = 1_000;

let activeCheck: Promise<void> | null = null;
let queuedSource: string | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function getPollIntervalMs() {
  const parsed = Number.parseInt(process.env.OMNIROUTE_CONFIG_HOT_RELOAD_MS || "", 10);
  if (!Number.isFinite(parsed) || parsed < MIN_POLL_INTERVAL_MS) {
    return DEFAULT_POLL_INTERVAL_MS;
  }
  return parsed;
}

function logChanges(source: string, changes: RuntimeReloadChange[]) {
  if (changes.length === 0) return;
  console.log(
    `[HOT_RELOAD] source=${source} reloaded sections: ${changes
      .map((entry) => entry.section)
      .join(", ")}`
  );
}

async function runHotReloadCheck(source: string) {
  const settings = await getSettings();
  const changes = await applyRuntimeSettings(settings, { source });
  logChanges(source, changes);
}

function queueHotReloadCheck(source: string) {
  if (activeCheck) {
    queuedSource = source;
    return;
  }

  activeCheck = runHotReloadCheck(source)
    .catch((error) => {
      console.warn(
        `[HOT_RELOAD] Runtime config reload failed for ${source}:`,
        error instanceof Error ? error.message : error
      );
    })
    .finally(() => {
      activeCheck = null;
      if (!queuedSource) return;
      const nextSource = queuedSource;
      queuedSource = null;
      queueHotReloadCheck(nextSource);
    });
}

export function startRuntimeConfigHotReload(options: { pollIntervalMs?: number } = {}) {
  if (pollTimer) return;

  const pollIntervalMs = Math.max(
    options.pollIntervalMs || getPollIntervalMs(),
    MIN_POLL_INTERVAL_MS
  );

  pollTimer = setInterval(() => {
    queueHotReloadCheck("hot-reload:poll");
  }, pollIntervalMs);
  if (typeof pollTimer === "object" && "unref" in pollTimer) {
    (pollTimer as { unref?: () => void }).unref?.();
  }

  console.log(`[HOT_RELOAD] Runtime config hot-reload started (poll=${pollIntervalMs}ms)`);

  queueHotReloadCheck("hot-reload:start");
}

export function stopRuntimeConfigHotReloadForTests() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  queuedSource = null;
  activeCheck = null;
}
