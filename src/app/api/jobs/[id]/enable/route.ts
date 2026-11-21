/**
 * POST /api/jobs/:id/enable
 *
 * Enable a disabled job and (re)start its timer. LOCAL_ONLY.
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
    await registry.setEnabled(id, true);
    return Response.json({ data: { id, enabled: true } });
  } catch (err) {
    console.error("[API] POST /api/jobs/:id/enable error:", err);
    return Response.json(buildErrorBody(500, "Failed to enable job"), { status: 500 });
  }
}
