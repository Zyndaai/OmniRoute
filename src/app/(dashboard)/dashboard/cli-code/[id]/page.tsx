import { data, useLoaderData } from "react-router";
import { CLI_TOOLS } from "@/shared/constants/cliTools";
import ToolDetailClient from "../components/ToolDetailClient";

export function loader({ params }: { params: { id?: string } }) {
  const id = params.id ?? "";
  const tool = CLI_TOOLS[id];
  if (!tool || tool.category !== "code") throw data(null, { status: 404 });
  return { id };
}

export default function CliCodeDetailPage() {
  const { id } = useLoaderData<typeof loader>();
  return <ToolDetailClient toolId={id} category="code" />;
}
