import type { ModelCapabilityEntry } from "../../modelsDevSync/transform";
import { db, type DbExecutor } from "../pg";
import { jsonToText } from "../pgJsonText";

interface StoredModalities {
  model_id: string;
  modalities_input: unknown;
  modalities_output: unknown;
}

function retainEquivalentSet(stored: string | null, incoming: string): string {
  if (stored === null || stored === incoming) return incoming;
  let before: unknown;
  let after: unknown;
  try {
    before = JSON.parse(stored);
    after = JSON.parse(incoming);
  } catch (error) {
    if (error instanceof SyntaxError) return incoming;
    throw error;
  }
  if (
    !Array.isArray(before) ||
    !Array.isArray(after) ||
    !before.every((value) => typeof value === "string") ||
    !after.every((value) => typeof value === "string")
  ) {
    return incoming;
  }
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return beforeSet.size === afterSet.size && [...beforeSet].every((value) => afterSet.has(value))
    ? stored
    : incoming;
}

/** Read through the given executor (the active transaction), not a possibly stale capabilities cache. */
export async function preserveStoredModalitySets(
  provider: string,
  models: Record<string, ModelCapabilityEntry>,
  ex: DbExecutor = db()
): Promise<Record<string, ModelCapabilityEntry>> {
  const modelIds = Object.keys(models);
  if (modelIds.length === 0) return {};
  const rows = await ex.query<StoredModalities>(
    `SELECT model_id, modalities_input, modalities_output FROM model_capabilities
     WHERE provider = $1 AND model_id = ANY($2::text[])`,
    [provider, modelIds]
  );
  const storedById = new Map(rows.map((row) => [row.model_id, row]));
  return Object.fromEntries(
    Object.entries(models).map(([modelId, entry]) => {
      const stored = storedById.get(modelId);
      return [
        modelId,
        {
          ...entry,
          modalities_input: retainEquivalentSet(
            stored ? jsonToText(stored.modalities_input) : null,
            entry.modalities_input
          ),
          modalities_output: retainEquivalentSet(
            stored ? jsonToText(stored.modalities_output) : null,
            entry.modalities_output
          ),
        },
      ];
    })
  );
}
