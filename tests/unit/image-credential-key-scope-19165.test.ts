// #19165: image credential fallback enforces the caller API key's connection scope on every
// attempt (selector-supplied, refreshed and keyless credentials), failing closed with 403
// before dispatch.
import assert from "node:assert/strict";
import test from "node:test";

import { executeImageWithCredentialFallback } from "../../src/sse/services/imageCredentialRetry.ts";

interface MockImageCredentials {
  connectionId: string;
  accessToken: string;
}

interface MockImageResult {
  success: boolean;
  status: number;
  error?: unknown;
  data?: unknown;
  retryable?: boolean;
}

test("image fallback must reject a selector returning an account outside the caller's API-key scope", async () => {
  const executed: string[] = [];
  let selectedScope: string[] | null = null;
  const first: MockImageCredentials = { connectionId: "allowed-1", accessToken: "first" };
  const forbidden: MockImageCredentials = { connectionId: "forbidden-2", accessToken: "second" };
  const result = await executeImageWithCredentialFallback({
    provider: "codex",
    requestedModel: "gpt-image-2",
    credentials: first,
    allowedConnections: ["allowed-1"],
    execute: async (credentials: MockImageCredentials): Promise<MockImageResult> => {
      executed.push(credentials.connectionId);
      return { success: false, status: 401, error: "expired token" };
    },
    selectNextCredentials: async (_provider, _model, _excluded, allowed) => {
      selectedScope = allowed;
      return forbidden;
    },
  });
  assert.deepEqual(selectedScope, ["allowed-1"]);
  assert.deepEqual(executed, ["allowed-1"]);
  assert.equal(result.result.status, 403);
});

test("image generation fails closed before sending on a disallowed initial credential", async () => {
  let executed = false;
  const result = await executeImageWithCredentialFallback({
    provider: "codex",
    requestedModel: "gpt-image-2",
    credentials: { connectionId: "forbidden", accessToken: "test" },
    allowedConnections: ["allowed"],
    execute: async (): Promise<MockImageResult> => {
      executed = true;
      return { success: true, status: 200 };
    },
  });
  assert.equal(executed, false);
  assert.equal(result.result.status, 403);
});

test("an empty API-key allowlist is not equivalent to an unscoped image request", async () => {
  let executions = 0;
  const result = await executeImageWithCredentialFallback({
    provider: "codex",
    requestedModel: "gpt-image-2",
    credentials: { connectionId: "some-account", accessToken: "test" },
    allowedConnections: [],
    execute: async (): Promise<MockImageResult> => {
      executions++;
      return { success: true, status: 200 };
    },
  });
  assert.equal(executions, 0);
  assert.equal(result.result.status, 403);
});

test("image account policy sentinel returns 403 without dispatch", async () => {
  let dispatched = 0;
  const { result } = await executeImageWithCredentialFallback({
    provider: "codex",
    requestedModel: "gpt-image-2",
    credentials: { blockedByKeyPolicy: true, blockedCount: 2 },
    allowedConnections: ["conn-permitted"],
    execute: async (): Promise<MockImageResult> => {
      dispatched++;
      return { success: true, status: 200 };
    },
  });
  assert.equal(result.status, 403);
  assert.equal(dispatched, 0);
});

test("policy denial after rotating a rejected account takes precedence over prior 401", async () => {
  let dispatched = 0;
  const { result } = await executeImageWithCredentialFallback({
    provider: "codex",
    requestedModel: "gpt-image-2",
    credentials: { connectionId: "conn-permitted", accessToken: "unused" },
    allowedConnections: ["conn-permitted"],
    execute: async (): Promise<MockImageResult> => {
      dispatched++;
      return { success: false, status: 401 };
    },
    selectNextCredentials: async () => ({ blockedByKeyPolicy: true }),
  });
  assert.equal(result.status, 403);
  assert.equal(dispatched, 1);
});

test("a scoped image key cannot dispatch without any credentials", async () => {
  for (const scope of [[], ["permitted-account"]]) {
    let executed = false;
    const { result } = await executeImageWithCredentialFallback({
      provider: "custom",
      requestedModel: "image-model",
      credentials: null,
      allowedConnections: scope,
      execute: async (): Promise<MockImageResult> => {
        executed = true;
        return { success: true, status: 200 };
      },
    });
    assert.equal(result.status, 403);
    assert.equal(executed, false);
  }
});

test("an unscoped local image provider may still dispatch without credentials", async () => {
  let executed = false;
  const { result } = await executeImageWithCredentialFallback({
    provider: "custom",
    requestedModel: "image-model",
    credentials: null,
    allowedConnections: null,
    execute: async (): Promise<MockImageResult> => {
      executed = true;
      return { success: true, status: 200 };
    },
  });
  assert.equal(result.status, 200);
  assert.equal(executed, true);
});

test("keyless image execution honors an explicit noauth connection scope", async () => {
  let dispatched = 0;
  const execute = async () => {
    dispatched++;
    return { success: true, status: 200 };
  };
  const allowed = await executeImageWithCredentialFallback({
    provider: "sdwebui",
    requestedModel: "sdwebui",
    credentials: null,
    allowedConnections: ["noauth"],
    execute,
  });
  assert.equal(allowed.result.status, 200);
  assert.equal(dispatched, 1);

  const denied = await executeImageWithCredentialFallback({
    provider: "sdwebui",
    requestedModel: "sdwebui",
    credentials: null,
    allowedConnections: ["unrelated-connection"],
    execute,
  });
  assert.equal(denied.result.status, 403);
  assert.equal(dispatched, 1);
});
