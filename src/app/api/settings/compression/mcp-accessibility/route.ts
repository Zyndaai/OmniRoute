import { getMcpAccessibilityConfig, setMcpAccessibilityConfig } from "@/lib/db/compression";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { mcpAccessibilityConfigSchema } from "@/shared/validation/compressionConfigSchemas";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

// Read/update the mcpAccessibility engine config (compression/mcpAccessibility DB key) that the
// MCP server consumes on every tool call to trim oversized tool outputs. Kept as a dedicated
// sub-route (sibling of settings/compression) so the strict main settings schema stays focused
// and the #4206 numeric bounds become reachable from the dashboard.

export async function GET(request: Request) {
  if (!(await isAuthenticated(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const config = await getMcpAccessibilityConfig();
    return Response.json(config);
  } catch (error) {
    return Response.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  if (!(await isAuthenticated(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const validation = validateBody(mcpAccessibilityConfigSchema, rawBody);
    if (isValidationFailure(validation)) {
      return Response.json({ error: validation.error }, { status: 400 });
    }

    // Partial-merge over the current config so toggling one field does not reset the others to
    // their defaults (setMcpAccessibilityConfig folds in DEFAULT + clampMcpAccessibilityConfig).
    const current = await getMcpAccessibilityConfig();
    await setMcpAccessibilityConfig({ ...current, ...validation.data });
    const config = await getMcpAccessibilityConfig();
    return Response.json(config);
  } catch (error) {
    return Response.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}
