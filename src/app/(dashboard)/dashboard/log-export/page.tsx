import { useLoaderData } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import { LogExportPageClient } from "./LogExportPageClient";
import type { LogExportStatus, LogExportTypeDescriptor } from "./types";

// Both reads are optional: the old page showed an error alert and an empty page when the status
// call failed (`loadFailed`), and an empty type list when the types call failed.
export async function loader() {
  const [status, typesBody] = await Promise.all([
    apiJsonOrNull<LogExportStatus>("/api/log-export/status"),
    apiJsonOrNull<{ types?: LogExportTypeDescriptor[] }>("/api/log-export/types"),
  ]);
  return {
    status,
    types: Array.isArray(typesBody?.types) ? typesBody.types : ([] as LogExportTypeDescriptor[]),
    loadFailed: status === null,
  };
}

export default function LogExportPage() {
  const { status, types, loadFailed } = useLoaderData<typeof loader>();
  return <LogExportPageClient status={status} types={types} loadFailed={loadFailed} />;
}
