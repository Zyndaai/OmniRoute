import { z } from "zod";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import {
  getNotionConfig,
  setNotionToken,
  clearNotionToken,
} from "@/lib/db/notion";
import { createNotionClient } from "@/lib/notion/api";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

const setTokenSchema = z.object({
  token: z.string().min(1).max(500),
}).strict();

export async function GET(request: Request) {
  if (!(await isAuthenticated(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const config = await getNotionConfig();
    return Response.json({
      connected: config.connected,
      hasToken: config.token !== null,
    });
  } catch (error) {
    return Response.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!(await isAuthenticated(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = setTokenSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json(
      { error: "Missing or invalid token", details: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    await setNotionToken(parsed.data.token);

    const client = createNotionClient(parsed.data.token);
    const result = await client.searchPagesAndDatabases("test", undefined, 1);
    if (result && typeof result === "object" && "object" in result && (result as Record<string, unknown>).object === "error") {
      await clearNotionToken();
      return Response.json(
        { error: "Token validation failed: invalid token", connected: false },
        { status: 400 }
      );
    }

    return Response.json({
      connected: true,
      message: "Notion integration token saved and validated",
    });
  } catch (error) {
    await clearNotionToken();
    const msg = error instanceof Error ? error.message : String(error);
    return Response.json({ error: sanitizeErrorMessage(msg), connected: false }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  if (!(await isAuthenticated(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await clearNotionToken();
    return Response.json({
      connected: false,
      message: "Notion integration disconnected",
    });
  } catch (error) {
    return Response.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}
