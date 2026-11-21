/**
 * API: Log export status
 * GET — Scheduler state (cron, enabled, recent runs) plus the current backlog, so the
 *       dashboard can answer "is the hourly export healthy?" in one request.
 */

import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getJobRegistry } from "@/lib/jobRegistry";
import { LOG_EXPORT_JOB_ID } from "@/lib/jobs/logExportJob";
import { getLogExportDestinations } from "@/lib/db/logExportDestinations";
import { getMaxCallLogRowId } from "@/lib/usage/callLogExportSource";
import { toDestinationView } from "@/lib/logExport/presenter";

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (authError) return authError;

  try {
    const destinations = await Promise.all(
      (await getLogExportDestinations()).map((row) => toDestinationView(row))
    );
    const registry = getJobRegistry();
    const job = (await registry.listJobs()).find((entry) => entry.id === LOG_EXPORT_JOB_ID) ?? null;

    return Response.json({
      job: job
        ? {
            id: job.id,
            enabled: job.enabled,
            cron: job.cron,
            timezone: (job.config?.timezone as string) ?? "UTC",
          }
        : null,
      runs: job ? await registry.getRuns(LOG_EXPORT_JOB_ID, 20) : [],
      maxCallLogRowId: await getMaxCallLogRowId(),
      destinations,
    });
  } catch (error: any) {
    return Response.json(
      { error: sanitizeErrorMessage(error) || "Failed to read log export status" },
      { status: 500 }
    );
  }
}
