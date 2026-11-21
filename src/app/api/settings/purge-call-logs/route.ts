import { buildErrorBody } from "@omniroute/open-sse/utils/error";
import { purgeCallLogs } from "@/lib/db/cleanup";
import { isAuthenticated } from "@/shared/utils/apiAuth";

export async function POST(request: Request) {
  if (!(await isAuthenticated(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await purgeCallLogs();
    return Response.json({
      deleted: result.deleted,
      deletedArtifacts: result.deletedArtifacts ?? 0,
      errors: result.errors,
    });
  } catch {
    return Response.json(buildErrorBody(500, "Failed to purge call logs"), {
      status: 500,
    });
  }
}
