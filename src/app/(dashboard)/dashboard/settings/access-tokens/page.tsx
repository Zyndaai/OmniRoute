import { useLoaderData } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import AccessTokensTab, { type AccessTokenRow } from "../components/AccessTokensTab";

// A failed read hands the tab `null`; it then fetches the list itself and shows the same load
// error as before. Creating and revoking tokens re-read the list in the tab, as they did.
export async function loader() {
  const body = await apiJsonOrNull<{ tokens?: AccessTokenRow[] }>("/api/cli/tokens");
  return { tokens: body ? (Array.isArray(body.tokens) ? body.tokens : []) : null };
}

export default function SettingsAccessTokensPage() {
  const { tokens } = useLoaderData<typeof loader>();
  return <AccessTokensTab initialTokens={tokens} />;
}
