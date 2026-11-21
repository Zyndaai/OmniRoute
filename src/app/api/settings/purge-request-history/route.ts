import { buildErrorBody } from "@omniroute/open-sse/utils/error";
import { purgeCallLogs } from "@/lib/db/cleanup";
import { isAuthenticated } from "@/shared/utils/apiAuth";

export async function POST(request: Request) {
  if (!(await isAuthenticated(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const callLogs = await purgeCallLogs();

    return Response.json(
      {
        deleted: callLogs.deleted,
        deletedArtifacts: callLogs.deletedArtifacts ?? 0,
        errors: callLogs.errors,
      },
      { status: callLogs.errors > 0 ? 500 : 200 }
    );
  } catch {
    return Response.json(buildErrorBody(500, "Failed to purge request history"), {
      status: 500,
    });
  }
}
