import { useLoaderData } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import { OmniSkillsPageClient, type OmniSkillsInitialData } from "./OmniSkillsPageClient";

// All three reads are optional: the old page showed empty lists when any of them failed.
// Filters, pagination and the marketplace stay client-side (they run on user actions).
export async function loader(): Promise<OmniSkillsInitialData> {
  const [skills, executions, settings] = await Promise.all([
    apiJsonOrNull<OmniSkillsInitialData["skills"]>("/api/skills", {
      query: { page: 1, limit: 20 },
    }),
    apiJsonOrNull<OmniSkillsInitialData["executions"]>("/api/skills/executions", {
      query: { page: 1, limit: 20 },
    }),
    apiJsonOrNull<{ skillsProvider?: string }>("/api/settings"),
  ]);
  return {
    skills: skills ?? {},
    executions: executions ?? {},
    skillsProvider: settings?.skillsProvider ?? null,
  };
}

export default function Page() {
  const initial = useLoaderData<typeof loader>();
  return <OmniSkillsPageClient initial={initial} />;
}
