import { NextResponse } from "next/server";
import { pingDb, getSchemaVersion } from "@/lib/db/core";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

/**
 * PostgreSQL health diagnosis. Keeps the shape the dashboard health card reads
 * (`isHealthy`, `issues`, `repairedCount`); there is nothing to auto-repair on Postgres,
 * so POST returns the same diagnosis as GET.
 */
async function diagnose() {
  const ok = await pingDb();
  const schemaVersion = ok ? await getSchemaVersion() : null;
  const issues: Array<{ message: string }> = [];
  if (!ok) issues.push({ message: "Database did not answer SELECT 1" });
  return { isHealthy: ok, issues, repairedCount: 0, backupCreated: false, schemaVersion };
}

async function handle(request: Request, label: string) {
  if (!(await isAuthenticated(request))) {
    return NextResponse.json({ error: { message: "Authentication required" } }, { status: 401 });
  }

  try {
    return NextResponse.json(await diagnose());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[API] DB health ${label} failed:`, message);
    return NextResponse.json(
      { error: { message: sanitizeErrorMessage(message) } },
      { status: 500 }
    );
  }
}

export async function GET(request: Request) {
  return handle(request, "diagnosis");
}

export async function POST(request: Request) {
  return handle(request, "check");
}
