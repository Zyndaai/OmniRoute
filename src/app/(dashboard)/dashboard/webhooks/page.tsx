import { useLoaderData } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import { WebhooksPageClient } from "./WebhooksPageClient";
import type { WebhookItem } from "./components/WebhookCard";

// The old page survived a failing read (error alert + empty list), so the read is optional and
// `loadFailed` tells the page to show the same alert.
export async function loader() {
  const body = await apiJsonOrNull<{ webhooks?: WebhookItem[] }>("/api/webhooks");
  return {
    webhooks: Array.isArray(body?.webhooks) ? body.webhooks : ([] as WebhookItem[]),
    loadFailed: body === null,
  };
}

export default function WebhooksPage() {
  const { webhooks, loadFailed } = useLoaderData<typeof loader>();
  return <WebhooksPageClient loadedWebhooks={webhooks} loadFailed={loadFailed} />;
}
