/**
 * GET /api/agent-skills/[id]
 *
 * Returns a single AgentSkill by its canonical ID.
 *
 * Response: AgentSkill
 * 404 if skill not found in catalog.
 */

import { buildErrorBody } from "@omniroute/open-sse/utils/error.ts";
import { getSkillById } from "@/lib/agentSkills/catalog";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    if (!id || typeof id !== "string") {
      return Response.json(buildErrorBody(400, "Missing skill id"), { status: 400 });
    }

    const skill = getSkillById(id);
    if (!skill) {
      return Response.json(buildErrorBody(404, `Skill not found: ${id}`), { status: 404 });
    }

    return Response.json(skill);
  } catch (error) {
    console.error("[API] GET /api/agent-skills/[id] error:", error);
    return Response.json(buildErrorBody(500, "Failed to load skill"), { status: 500 });
  }
}
