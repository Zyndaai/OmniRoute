import { getSettings, updateSettings } from "@/lib/db/settings";
import {
  setThinkingBudgetConfig,
  getThinkingBudgetConfig,
  ThinkingMode,
} from "@omniroute/open-sse/services/thinkingBudget.ts";
import { updateThinkingBudgetSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  try {
    const config = getThinkingBudgetConfig();
    return Response.json(config);
  } catch (error) {
    console.error("Error reading thinking budget config:", error);
    return Response.json({ error: "Failed to read thinking budget config" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json(
      {
        error: {
          message: "Invalid request",
          details: [{ field: "body", message: "Invalid JSON body" }],
        },
      },
      { status: 400 }
    );
  }

  try {
    const validation = validateBody(updateThinkingBudgetSchema, rawBody);
    if (isValidationFailure(validation)) {
      return Response.json({ error: validation.error }, { status: 400 });
    }
    const body = validation.data;

    // Apply config in-memory
    setThinkingBudgetConfig(body);

    // Persist to settings DB
    await updateSettings({ thinkingBudget: body });

    return Response.json(getThinkingBudgetConfig());
  } catch (error) {
    console.error("Error updating thinking budget config:", error);
    return Response.json({ error: "Failed to update thinking budget config" }, { status: 500 });
  }
}
