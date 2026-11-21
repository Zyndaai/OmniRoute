/**
 * API: Log export destination connectivity test
 * POST — Probe credentials and reachability without writing any rows.
 */

import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getLogExportDestination } from "@/lib/db/logExportDestinations";
import { createClientForDestination } from "@/lib/logExport/runner";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authError = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (authError) return authError;

  try {
    const { id } = await params;
    const destination = await getLogExportDestination(id);
    if (!destination) {
      return Response.json({ error: "Log export destination not found" }, { status: 404 });
    }

    const client = createClientForDestination(destination);
    const result = await client.test();
    return Response.json({ ok: result.ok, detail: sanitizeErrorMessage(result.detail) });
  } catch (error: any) {
    // A failed probe is a valid answer, not a server fault: report it as a 200 with
    // ok:false so the dashboard can show the reason inline.
    return Response.json({ ok: false, detail: sanitizeErrorMessage(error) });
  }
}
