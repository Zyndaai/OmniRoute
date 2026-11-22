import { useLoaderData } from "react-router";
import ToolDetailClient from "../../cli-code/components/ToolDetailClient";
import { loadToolDetail } from "../../cli-code/components/toolDetailData.server";

export async function loader({ params }: { params: { id?: string } }) {
  return loadToolDetail(params.id ?? "", "agent");
}

export default function CliAgentsDetailPage() {
  const { id, connections, apiKeys, cloudEnabled } = useLoaderData<typeof loader>();
  return (
    <ToolDetailClient
      toolId={id}
      category="agent"
      connections={connections}
      apiKeys={apiKeys}
      cloudEnabled={cloudEnabled}
    />
  );
}
