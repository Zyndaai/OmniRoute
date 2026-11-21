import { isAuthenticated } from "@/shared/utils/apiAuth";
import { getCompressionRunTelemetrySummary } from "@/lib/db/compressionRunTelemetry";

export async function GET(request: Request) {
  if (!(await isAuthenticated(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await getCompressionRunTelemetrySummary();
    return Response.json(summary);
  } catch {
    return Response.json(
      {
        totalRuns: 0,
        totalTokensSaved: 0,
        runsWithStyles: 0,
        bypassCount: 0,
        totalOutputTokens: 0,
        appliedStyleCounts: {},
      },
      { status: 200 }
    );
  }
}
