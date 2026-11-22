import { useLoaderData } from "react-router";
import ToolDetailClient from "../components/ToolDetailClient";
import { loadToolDetail } from "../components/toolDetailData.server";

export async function loader({ params }: { params: { id?: string } }) {
  return loadToolDetail(params.id ?? "", "code");
}

export default function CliCodeDetailPage() {
  const { id, connections, apiKeys, cloudEnabled } = useLoaderData<typeof loader>();
  return (
    <ToolDetailClient
      toolId={id}
      category="code"
      connections={connections}
      apiKeys={apiKeys}
      cloudEnabled={cloudEnabled}
    />
  );
}
