import { useLoaderData } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import type { AgentSkill, SkillCoverage } from "@/lib/agentSkills/types";
import { AgentSkillsPageClient } from "./AgentSkillsPageClient";

/** A failed read shows an empty catalog and no coverage, as the old page did (optional read). */
export async function loader() {
  const json = await apiJsonOrNull<{ skills?: AgentSkill[]; coverage?: SkillCoverage }>(
    "/api/agent-skills"
  );
  return { catalog: json?.skills ?? [], coverage: json?.coverage ?? null };
}

export default function Page() {
  const { catalog, coverage } = useLoaderData<typeof loader>();
  return <AgentSkillsPageClient catalog={catalog} coverage={coverage} />;
}
