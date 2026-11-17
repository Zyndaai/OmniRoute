/**
 * Detailed Request Logs (#378)
 *
 * Pipeline details live inside the unified call log artifacts; this module only answers
 * whether they are captured.
 */
import { getCachedSettings } from "./readCache";

/** True when pipeline details are captured: ENABLE_REQUEST_LOGS wins over the setting. */
export async function isDetailedLoggingEnabled(): Promise<boolean> {
  const envOverride = process.env.ENABLE_REQUEST_LOGS;
  if (envOverride !== undefined) {
    return envOverride.trim().toLowerCase() === "true";
  }

  try {
    const val = (await getCachedSettings()).call_log_pipeline_enabled;
    return val === true || val === "1" || val === "true";
  } catch {
    return false;
  }
}
