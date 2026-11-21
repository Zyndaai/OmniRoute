import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  createReasoningRoutingRule,
  getReasoningRoutingRules,
} from "@/lib/db/reasoningRoutingRules";
import { reasoningRuleDataToInput } from "@/lib/reasoningRouting/input";
import { createReasoningRoutingRuleSchema } from "@/shared/validation/schemas";
import { validatedJsonBody } from "@/shared/validation/helpers";
import { buildErrorBody, sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  return Response.json({ rules: await getReasoningRoutingRules() });
}

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const parsed = await validatedJsonBody(request, createReasoningRoutingRuleSchema);
  if (parsed.success === false) return parsed.response;
  try {
    const rule = await createReasoningRoutingRule(reasoningRuleDataToInput(parsed.data));
    return Response.json({ rule }, { status: 201 });
  } catch (error) {
    const message = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
    return Response.json(buildErrorBody(400, message), { status: 400 });
  }
}
