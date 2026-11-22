import { useLoaderData } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import A2aAuditTab from "../A2aAuditTab";

/**
 * First page of A2A tasks for the default (unfiltered) view. Optional read: when it fails the
 * tab shows an empty list, as the client fetch did.
 */
export async function loader() {
  const tasks = await apiJsonOrNull<Record<string, unknown>>("/api/a2a/tasks", {
    query: { limit: 25, offset: 0 },
  });
  return { tasks: tasks ?? {} };
}

export default function AuditA2aPage() {
  const { tasks } = useLoaderData<typeof loader>();
  return <A2aAuditTab initial={tasks} />;
}
