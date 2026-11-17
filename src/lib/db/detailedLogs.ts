/**
 * Detailed Request Logs (#378)
 *
 * Pipeline details live inside the unified call log artifacts. The legacy
 * `request_detail_logs` table is gone with the move to PostgreSQL, so only the
 * settings check remains here.
 */
import { getSettings } from "./settings";

export interface RequestDetailLog {
  id?: string;
  call_log_id?: string | null;
  timestamp?: string;
  client_request?: unknown | null;
  translated_request?: unknown | null;
  provider_response?: unknown | null;
  client_response?: unknown | null;
  provider?: string | null;
  model?: string | null;
  source_format?: string | null;
  target_format?: string | null;
  duration_ms?: number;
  api_key_id?: string | null;
  no_log?: boolean;
}

/** Returns true if detailed logging is enabled in settings */
export async function isDetailedLoggingEnabled(): Promise<boolean> {
  const envOverride = process.env.ENABLE_REQUEST_LOGS;
  if (envOverride !== undefined) {
    return envOverride.trim().toLowerCase() === "true";
  }

  try {
    const settings = await getSettings();
    const val = settings.call_log_pipeline_enabled;
    return val === true || val === "1" || val === "true";
  } catch {
    return false;
  }
}
