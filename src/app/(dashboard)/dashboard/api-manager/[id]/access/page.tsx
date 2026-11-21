import { useLoaderData } from "react-router";
import ApiKeyAccessEditorClient from "./ApiKeyAccessEditorClient";

export function loader({ params }: { params: { id?: string } }) {
  return { id: params.id ?? "" };
}

export default function ApiKeyAccessPage() {
  const { id } = useLoaderData<typeof loader>();
  return <ApiKeyAccessEditorClient apiKeyId={id} />;
}
