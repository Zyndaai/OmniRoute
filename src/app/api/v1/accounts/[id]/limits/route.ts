import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { setAccountKeyLimit, getAccountKeyLimit } from "@/lib/db/registeredKeys";

const limitsSchema = z.object({
  maxActiveKeys: z.number().int().positive().nullable().optional(),
  dailyIssueLimit: z.number().int().positive().nullable().optional(),
  hourlyIssueLimit: z.number().int().positive().nullable().optional(),
});

/**
 * GET /api/v1/accounts/[id]/limits
 * Get the current issuance limits for an account.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const resolvedParams = await params;
  const limits = await getAccountKeyLimit(resolvedParams.id);
  return Response.json({ accountId: resolvedParams.id, limits: limits ?? null });
}

/**
 * PUT /api/v1/accounts/[id]/limits
 * Configure issuance limits for an account.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validation = validateBody(limitsSchema, rawBody);
  if (isValidationFailure(validation)) {
    return Response.json({ error: validation.error }, { status: 400 });
  }

  const resolvedParams = await params;
  await setAccountKeyLimit(resolvedParams.id, validation.data);
  const updated = await getAccountKeyLimit(resolvedParams.id);
  return Response.json({ accountId: resolvedParams.id, limits: updated });
}
