/**
 * GET  /api/logs/detail  — Current pipeline capture flag (the legacy request_detail_logs list is gone)
 * POST /api/logs/detail — Enable/disable pipeline capture for unified call log artifacts
 */
import { NextRequest, NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { isDetailedLoggingEnabled } from "@/lib/db/detailedLogs";
import { updateSettings } from "@/lib/db/settings";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const authError = await requireManagementAuth(req);
  if (authError) return authError;

  const enabled = await isDetailedLoggingEnabled();

  return NextResponse.json({ enabled, total: 0, logs: [] });
}

export async function POST(req: NextRequest) {
  const authError = await requireManagementAuth(req);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
  }
  const { enabled: rawEnabled } = body as { enabled?: unknown };
  const enabled = rawEnabled === true || rawEnabled === "1";

  await updateSettings({ call_log_pipeline_enabled: enabled });

  return NextResponse.json({
    success: true,
    enabled,
    message: enabled
      ? "Pipeline capture enabled. New request artifacts will include per-stage payloads."
      : "Pipeline capture disabled.",
  });
}
