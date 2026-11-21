import { getCostSummary, setBudget, checkBudget } from "@/domain/costRules";
import { setBudgetSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";

export async function GET(request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { searchParams } = new URL(request.url);
    const apiKeyId = searchParams.get("apiKeyId");
    if (!apiKeyId) {
      return Response.json({ error: "apiKeyId query param is required" }, { status: 400 });
    }
    const summary = await getCostSummary(apiKeyId);
    const budgetCheck = await checkBudget(apiKeyId);
    return Response.json({
      ...summary,
      budgetCheck,
      dailyLimitUsd: summary.dailyLimitUsd,
      weeklyLimitUsd: summary.weeklyLimitUsd,
      monthlyLimitUsd: summary.monthlyLimitUsd,
      warningThreshold: summary.warningThreshold,
      resetInterval: summary.resetInterval,
      resetTime: summary.resetTime,
      budgetResetAt: summary.budgetResetAt,
      lastBudgetResetAt: summary.lastBudgetResetAt,
      totalCostToday: summary.totalCostToday,
      totalCostMonth: summary.totalCostMonth,
      totalCostPeriod: summary.totalCostPeriod,
      activeLimitUsd: summary.activeLimitUsd,
      nextResetAt: summary.nextResetAt,
      periodStartAt: summary.periodStartAt,
    });
  } catch (error) {
    console.error("Error fetching budget summary:", error);
    return Response.json({ error: "Failed to fetch budget summary" }, { status: 500 });
  }
}

export async function POST(request) {
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
    const validation = validateBody(setBudgetSchema, rawBody);
    if (isValidationFailure(validation)) {
      return Response.json({ error: validation.error }, { status: 400 });
    }
    const {
      apiKeyId,
      dailyLimitUsd,
      weeklyLimitUsd,
      monthlyLimitUsd,
      warningThreshold,
      resetInterval,
      resetTime,
    } = validation.data;

    const budget = await setBudget(apiKeyId, {
      dailyLimitUsd,
      weeklyLimitUsd,
      monthlyLimitUsd,
      warningThreshold,
      resetInterval,
      resetTime,
    });
    return Response.json({ success: true, apiKeyId, budget });
  } catch (error) {
    console.error("Error setting budget:", error);
    return Response.json({ error: "Failed to set budget" }, { status: 500 });
  }
}
