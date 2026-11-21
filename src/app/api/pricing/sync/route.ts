/**
 * API Route: /api/pricing/sync
 *
 * POST — Trigger a manual pricing sync from external sources.
 * GET  — Get current sync status.
 * DELETE — Clear all synced pricing data.
 */

import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { pricingSyncRequestSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
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
    const validation = validateBody(pricingSyncRequestSchema, rawBody);
    if (isValidationFailure(validation)) {
      return Response.json({ error: validation.error }, { status: 400 });
    }
    const { sources, dryRun = false } = validation.data;

    const { syncPricingFromSources } = await import("@/lib/pricingSync");
    const result = await syncPricingFromSources({ sources, dryRun });

    return Response.json(result, { status: result.success ? 200 : 502 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { getSyncStatus } = await import("@/lib/pricingSync");
    return Response.json(await getSyncStatus());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { clearSyncedPricing } = await import("@/lib/pricingSync");
    await clearSyncedPricing();
    return Response.json({ success: true, message: "Synced pricing data cleared" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
