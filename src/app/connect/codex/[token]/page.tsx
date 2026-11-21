import { useParams } from "react-router";

import CodexConnectClient from "./CodexConnectClient";

/**
 * Public Codex connect page (outside the dashboard auth gate).
 *
 * A third party opens the shared `/codex/connect/{token}` link and completes the
 * Codex device flow in their own browser. The page only resolves the route token
 * and hands it to the client component that drives the flow.
 */
export default function CodexConnectPage() {
  const { token = "" } = useParams();
  return <CodexConnectClient token={token} />;
}
