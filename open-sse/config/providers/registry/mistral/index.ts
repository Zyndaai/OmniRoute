import type { RegistryEntry } from "../../shared.ts";

export const mistralProvider: RegistryEntry = {
  id: "mistral",
  alias: "mistral",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.mistral.ai/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  toolNameMaxLength: 64,
  models: [
    { id: "mistral-large-latest", name: "Mistral Large 3" },
    // supportsReasoning marks the models that take reasoning_effort; the sanitizer strips the
    // field for every other catalogued Mistral model.
    { id: "mistral-medium-3-5", name: "Mistral Medium 3.5", supportsReasoning: true },
    { id: "mistral-small-latest", name: "Mistral Small 4", supportsReasoning: true },
    { id: "devstral-latest", name: "Devstral 2" },
    { id: "codestral-latest", name: "Codestral" },
  ],
};
