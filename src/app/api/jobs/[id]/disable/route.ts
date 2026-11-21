/**
 * POST /api/jobs/:id/disable
 *
 * Disable a job and stop its timer. LOCAL_ONLY.
 */

import { buildErrorBody } from "@omniroute/open-sse/utils/error.ts";
import { getJobRegistry } from "@/lib/jobRegistry";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const registry = getJobRegistry();
    if (!(await registry.listJobs()).some((j) => j.id === id)) {
      return Response.json(buildErrorBody(404, "Job not found"), { status: 404 });
    }
    await registry.setEnabled(id, false);
    return Response.json({ data: { id, enabled: false } });
  } catch (err) {
    console.error("[API] POST /api/jobs/:id/disable error:", err);
    return Response.json(buildErrorBody(500, "Failed to disable job"), { status: 500 });
  }
}
