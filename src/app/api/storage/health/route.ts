import { NextResponse } from "next/server";
import { resolveDataDir } from "@/lib/dataPaths";
import {
  getAppLogRetentionDays,
  getCallLogRetentionDays,
  getCallLogsTableMaxRows,
  getProxyLogsTableMaxRows,
} from "@/lib/logEnv";
import { db } from "@/lib/db/pg";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

/**
 * GET /api/storage/health — Return database storage information.
 * Provides: driver, database size, retention windows and table row caps.
 */
export async function GET() {
  try {
    const dataDir = resolveDataDir({});

    let sizeBytes = 0;
    try {
      const row = await db().queryOne<{ size: string | number }>(
        "SELECT pg_database_size(current_database()) AS size"
      );
      sizeBytes = Number(row?.size ?? 0);
    } catch {
      /* ignore */
    }

    const homeDir = process.env.HOME || process.env.USERPROFILE || "";

    return NextResponse.json({
      driver: "postgres",
      sizeBytes,
      retentionDays: {
        app: getAppLogRetentionDays(),
        call: getCallLogRetentionDays(),
      },
      tableMaxRows: {
        callLogs: getCallLogsTableMaxRows(),
        proxyLogs: getProxyLogsTableMaxRows(),
      },
      dataDir: homeDir && dataDir.startsWith(homeDir) ? "~" + dataDir.slice(homeDir.length) : dataDir,
    });
  } catch (error) {
    console.error("[API] Error getting storage health:", error);
    return NextResponse.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}
