import { data, useLoaderData } from "react-router";
import { CLI_TOOLS } from "@/shared/constants/cliTools";
import ToolDetailClient from "../../cli-code/components/ToolDetailClient";

export function loader({ params }: { params: { id?: string } }) {
  const id = params.id ?? "";
  const tool = CLI_TOOLS[id];
  if (!tool || tool.category !== "agent") throw data(null, { status: 404 });
  return { id };
}

export default function CliAgentsDetailPage() {
  const { id } = useLoaderData<typeof loader>();
  return <ToolDetailClient toolId={id} category="agent" />;
}
