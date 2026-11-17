import { getTaskFitness } from "./taskFitness.ts";

export type SyncTaskFitness = (model: string, taskType: string) => number;

/**
 * getTaskFitness is async (DB-backed overrides); the scoring functions take a
 * synchronous lookup. Resolve every model's score for the task type up front
 * and hand scoring a plain map reader.
 */
export async function loadTaskFitnessLookup(
  models: Iterable<string>,
  taskType: string
): Promise<SyncTaskFitness> {
  const unique = [...new Set(models)];
  const entries = await Promise.all(
    unique.map(async (model) => [model, await getTaskFitness(model, taskType)] as const)
  );
  const scores = new Map(entries);
  return (model, requestedTaskType) =>
    requestedTaskType === taskType ? (scores.get(model) ?? 0.5) : 0.5;
}
