import { useLoaderData } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import type { AuditLogEntry } from "@/lib/compliance/index";
import ActivityFeedClient from "./ActivityFeedClient";

const FEED_LIMIT = 200;

/**
 * Optional read: when the audit log fails to load the page shows an error alert over an empty
 * feed, as before. `loadedAt` is the reference time for the relative timestamps.
 */
export async function loader() {
  const entries = await apiJsonOrNull<AuditLogEntry[]>("/api/compliance/audit-log", {
    query: { level: "high", limit: FEED_LIMIT },
  });
  return {
    entries: Array.isArray(entries) ? entries : [],
    failed: entries === null,
    loadedAt: Date.now(),
  };
}

export default function ActivityPage() {
  const { entries, failed, loadedAt } = useLoaderData<typeof loader>();
  return <ActivityFeedClient entries={entries} failed={failed} loadedAt={loadedAt} />;
}
