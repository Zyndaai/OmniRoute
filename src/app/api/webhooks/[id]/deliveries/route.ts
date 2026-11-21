/**
 * API: Webhook Delivery History
 * GET — List recent deliveries for a webhook
 */

import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { getWebhook } from "@/lib/db/webhooks";
import { getDeliveries } from "@/lib/db/webhookDeliveries";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { id } = await params;
    const webhook = await getWebhook(id);
    if (!webhook) {
      return Response.json({ error: "Webhook not found" }, { status: 404 });
    }

    const url = new URL(request.url);
    const limitParam = url.searchParams.get("limit");
    const limit = Math.min(Math.max(1, parseInt(limitParam ?? "20", 10) || 20), 100);

    const deliveries = await getDeliveries(id, limit);
    return Response.json({ deliveries });
  } catch (error: any) {
    return Response.json(
      { error: sanitizeErrorMessage(error) || "Failed to fetch deliveries" },
      { status: 500 }
    );
  }
}
