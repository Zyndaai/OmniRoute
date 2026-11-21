import type { A2ATask, TaskArtifact } from "./taskManager";
import type { A2ACallerContext } from "./selfLoopAuth";

type TaskManagerLike = {
  updateTask: (
    taskId: string,
    state: "completed" | "failed",
    artifacts?: Array<{ type: string; content: string }>,
    message?: string
  ) => unknown;
};

type StreamTaskResult = {
  artifacts: TaskArtifact[];
  metadata: Record<string, unknown>;
};

/** `caller` carries the A2A caller's API key: skills that call back into OmniRoute use it. */
export type A2ASkillHandler = (
  task: A2ATask,
  caller?: A2ACallerContext
) => Promise<StreamTaskResult>;

export const A2A_SKILL_HANDLERS: Record<string, A2ASkillHandler> = {
  "smart-routing": async (task, caller) => {
    const skillModule = await import("./skills/smartRouting");
    return skillModule.executeSmartRouting(task, caller);
  },
  "quota-management": async (task, caller) => {
    const skillModule = await import("./skills/quotaManagement");
    return skillModule.executeQuotaManagement(task, caller);
  },
  "provider-discovery": async (task) => {
    const skillModule = await import("./skills/providerDiscovery");
    return skillModule.executeProviderDiscovery(task);
  },
  "cost-analysis": async (task, caller) => {
    const skillModule = await import("./skills/costAnalysis");
    return skillModule.executeCostAnalysis(task, caller);
  },
  "health-report": async (task, caller) => {
    const skillModule = await import("./skills/healthReport");
    return skillModule.executeHealthReport(task, caller);
  },
  "list-capabilities": async (task) => {
    const skillModule = await import("./skills/listCapabilities");
    return skillModule.executeListCapabilities(task);
  },
};

export async function executeA2ATaskWithState(
  tm: TaskManagerLike,
  task: A2ATask,
  handler: (task: A2ATask) => Promise<StreamTaskResult>
) {
  try {
    const result = await handler(task);
    tm.updateTask(task.id, "completed", result.artifacts);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      tm.updateTask(task.id, "failed", [{ type: "error", content: msg }], msg);
    } catch {
      // Task may already be terminal (e.g., cancelled). Preserve original error.
    }
    throw err;
  }
}
