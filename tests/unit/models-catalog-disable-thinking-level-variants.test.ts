import { test, after } from "node:test";
import assert from "node:assert/strict";
import { applyCatalogPostFilters } from "../../src/app/api/v1/models/catalogResponse.ts";
import {
  removeFeatureFlagOverride,
  setFeatureFlagOverride,
} from "../../src/lib/db/featureFlags.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";
import { refreshFeatureFlagSnapshot } from "../../src/shared/utils/featureFlags.ts";

after(async () => {
  await removeFeatureFlagOverride("OMNIROUTE_DISABLE_THINKING_LEVEL_VARIANTS");
  await resetDbInstance();
});

test("catalog advertises claude effort variants by default", async () => {
  const out = await applyCatalogPostFilters(
    new Request("http://localhost/v1/models"),
    [
      { id: "cmd/claude-opus-4-7", owned_by: "command-code", type: "chat" },
      { id: "dva/claude-fable-5-1", owned_by: "devin-cli-agentic", type: "chat" },
    ],
    { connections: [], prefixMode: "dual", aliasToProviderId: {}, hideNoThinkVariants: true }
  );
  assert.deepEqual(
    out.map((m) => m.id),
    [
      "cmd/claude-opus-4-7",
      "dva/claude-fable-5-1",
      "cmd/claude-opus-4-7-low",
      "cmd/claude-opus-4-7-medium",
      "cmd/claude-opus-4-7-high",
      "cmd/claude-opus-4-7-xhigh",
    ]
  );
});

test("catalog filters claude effort variants when the flag is set", async () => {
  await setFeatureFlagOverride("OMNIROUTE_DISABLE_THINKING_LEVEL_VARIANTS", "true");
  // Flag reads are synchronous and served from an in-process snapshot (see featureFlags.ts).
  await refreshFeatureFlagSnapshot();
  const out = await applyCatalogPostFilters(
    new Request("http://localhost/v1/models"),
    [
      { id: "cmd/claude-opus-4-7", owned_by: "command-code", type: "chat" },
      { id: "dva/claude-fable-5-1", owned_by: "devin-cli-agentic", type: "chat" },
    ],
    { connections: [], prefixMode: "dual", aliasToProviderId: {}, hideNoThinkVariants: true }
  );
  assert.deepEqual(
    out.map((m) => m.id),
    ["cmd/claude-opus-4-7", "dva/claude-fable-5-1"]
  );
});

test("catalog advertises claude effort variants when the flag is explicitly unset", async () => {
  await setFeatureFlagOverride("OMNIROUTE_DISABLE_THINKING_LEVEL_VARIANTS", "false");
  await refreshFeatureFlagSnapshot();
  const out = await applyCatalogPostFilters(
    new Request("http://localhost/v1/models"),
    [
      { id: "cmd/claude-opus-4-7", owned_by: "command-code", type: "chat" },
      { id: "dva/claude-fable-5-1", owned_by: "devin-cli-agentic", type: "chat" },
    ],
    { connections: [], prefixMode: "dual", aliasToProviderId: {}, hideNoThinkVariants: true }
  );
  assert.deepEqual(
    out.map((m) => m.id),
    [
      "cmd/claude-opus-4-7",
      "dva/claude-fable-5-1",
      "cmd/claude-opus-4-7-low",
      "cmd/claude-opus-4-7-medium",
      "cmd/claude-opus-4-7-high",
      "cmd/claude-opus-4-7-xhigh",
    ]
  );
});
