// Routing, policy and route-shape behavior around handleChat (src/sse/handlers/chat.ts) and the
// /v1/chat/completions route: peer-loop rejection, combo authority flow, the route shape gate,
// the safety-net combo redirect, Qoder PAT tool routing and stalled-account avoidance inside a
// combo. Merged from six files so the chat handler module graph loads once; each original file is
// one `describe` below, named after the file it came from.
//
// Load-time env shared by all of them: DATA_DIR, OMNIROUTE_PLUGINS_DIR (under DATA_DIR),
// REQUIRE_API_KEY=false and a single API_KEY_SECRET. Every describe that needs a clean database
// resets it in its own hooks.
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import {
  applyPeerTraceHeader,
  inspectPeerRequest,
  isConfiguredOmniRoutePeer,
  parsePeerTrace,
} from "../../../src/shared/resilience/peerRouting";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-chat-handler-routing-"));
const TEST_PLUGIN_DIR = path.join(TEST_DATA_DIR, "plugins");
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.OMNIROUTE_PLUGINS_DIR = TEST_PLUGIN_DIR;
process.env.REQUIRE_API_KEY = "false";
process.env.INITIAL_PASSWORD = "";
process.env.DASHBOARD_PASSWORD = "";
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "test-chat-handler-routing";
delete process.env.JWT_SECRET;
delete process.env.QUOTA_STORE_DRIVER;
delete process.env.QUOTA_STORE_REDIS_URL;

const { resetTestDb } = await import("../../helpers/postgres.ts");
const core = await import("../../../src/lib/db/core.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const combosDb = await import("../../../src/lib/db/combos.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const proxyLogger = await import("../../../src/lib/proxyLogger.ts");
const { flushProxyLogsSync } = proxyLogger;
const callLogs = await import("../../../src/lib/usage/callLogs.ts");
const { handleChat } = await import("../../../src/sse/handlers/chat.ts");
const chatRoute = await import("../../../src/app/api/v1/chat/completions/route.ts");
const { getProviderCredentials } = await import("../../../src/sse/services/auth.ts");
const { initTranslators } = await import("../../../open-sse/translator/index.ts");
const { clearInflight } = await import("../../../open-sse/services/requestDedup.ts");
const { resetAllCircuitBreakers } = await import("../../../src/shared/utils/circuitBreaker.ts");
const { QoderExecutor } = await import("../../../open-sse/executors/qoder.ts");
const { resolveQoderAuthToken, qoderSupportsCallerTools, hasQoderCallerTools } =
  await import("../../../open-sse/services/qoderCapabilities.ts");
const { buildTargetTimeoutRunner } =
  await import("../../../open-sse/services/combo/targetTimeoutRunner.ts");
const { COMBO_HEDGE_CANCELLED_REASON, COMBO_PER_MODEL_TIMEOUT_REASON } =
  await import("../../../open-sse/services/combo/comboAbortReasons.ts");
const stalledConnections =
  await import("../../../src/sse/handlers/chat/comboStalledConnections.ts");

const originalFetch = globalThis.fetch;

after(async () => {
  globalThis.fetch = originalFetch;
  await proxyLogger.flushProxyLogsSync();
  apiKeysDb.resetApiKeyState();
  await resetTestDb();
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("peer-routing", () => {
  const env = {
    OMNIROUTE_INSTANCE_ID: "gateway-a",
    OMNIROUTE_PEER_URLS: "http://gateway-b:20128/v1,https://peer.example/api/v1/",
    OMNIROUTE_PEER_MAX_HOPS: "4",
  };

  test("peer routing stays disabled without an instance id", () => {
    const headers: Record<string, string> = {};
    assert.equal(
      applyPeerTraceHeader(headers, null, "http://gateway-b:20128/v1/chat/completions", {
        ...env,
        OMNIROUTE_INSTANCE_ID: undefined,
      }),
      false
    );
    assert.deepEqual(headers, {});
    assert.equal(
      inspectPeerRequest(new Headers({ "X-OmniRoute-Peer-Trace": "gateway-a" }), {}),
      null
    );
  });

  test("peer URL matching requires the configured origin and path boundary", () => {
    assert.equal(
      isConfiguredOmniRoutePeer("http://gateway-b:20128/v1/chat/completions", env),
      true
    );
    assert.equal(isConfiguredOmniRoutePeer("https://peer.example/api/v1/responses", env), true);
    assert.equal(
      isConfiguredOmniRoutePeer("http://gateway-b:20128/v10/chat/completions", env),
      false
    );
    assert.equal(
      isConfiguredOmniRoutePeer("http://gateway-b.evil:20128/v1/chat/completions", env),
      false
    );
  });

  test("outbound peer calls append the local instance to the existing trace", () => {
    const headers: Record<string, string> = { Authorization: "Bearer test" };
    const applied = applyPeerTraceHeader(
      headers,
      { "x-omniroute-peer-trace": "edge,gateway-z" },
      "http://gateway-b:20128/v1/chat/completions",
      env
    );
    assert.equal(applied, true);
    assert.equal(headers["X-OmniRoute-Peer-Trace"], "edge,gateway-z,gateway-a");
    assert.equal(headers.Authorization, "Bearer test");
  });

  test("non-peer providers never receive peer metadata", () => {
    const headers: Record<string, string> = {};
    assert.equal(
      applyPeerTraceHeader(headers, null, "https://api.openai.com/v1/chat/completions", env),
      false
    );
    assert.equal(headers["X-OmniRoute-Peer-Trace"], undefined);
  });

  test("ingress rejects a repeated instance and an exhausted hop budget", () => {
    assert.deepEqual(
      inspectPeerRequest(new Headers({ "X-OmniRoute-Peer-Trace": "edge,gateway-a" }), env),
      {
        code: "peer_loop_detected",
        message: "OmniRoute peer routing loop detected",
      }
    );
    assert.deepEqual(
      inspectPeerRequest(
        { "X-OmniRoute-Peer-Trace": "gateway-w,gateway-x,gateway-y,gateway-z" },
        env
      ),
      {
        code: "peer_hop_limit_exceeded",
        message: "OmniRoute peer routing hop limit exceeded",
      }
    );
  });

  test("trace parsing drops invalid IDs and oversized untrusted values", () => {
    assert.deepEqual(parsePeerTrace("gateway-a, bad id, gateway_b"), ["gateway-a", "gateway_b"]);
    assert.deepEqual(parsePeerTrace("x".repeat(2049)), []);
  });

  test("BaseExecutor adds the trace only on an allowlisted peer dispatch", async () => {
    const previous = {
      instanceId: process.env.OMNIROUTE_INSTANCE_ID,
      peerUrls: process.env.OMNIROUTE_PEER_URLS,
      maxHops: process.env.OMNIROUTE_PEER_MAX_HOPS,
    };
    let capturedTrace: string | undefined;
    const server = createServer((request, response) => {
      capturedTrace = request.headers["x-omniroute-peer-trace"];
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const peerBaseUrl = `http://127.0.0.1:${address.port}/v1`;

    process.env.OMNIROUTE_INSTANCE_ID = "gateway-a";
    process.env.OMNIROUTE_PEER_URLS = peerBaseUrl;
    process.env.OMNIROUTE_PEER_MAX_HOPS = "4";

    try {
      const { BaseExecutor } = await import("../../../open-sse/executors/base.ts");
      const executor = new BaseExecutor("openai-compatible-peer", {
        baseUrl: peerBaseUrl,
      });
      await executor.execute({
        model: "peer-model",
        body: { model: "peer-model", messages: [{ role: "user", content: "ping" }] },
        stream: false,
        credentials: {
          apiKey: "peer-key",
          providerSpecificData: { baseUrl: peerBaseUrl },
        },
        clientHeaders: { "x-omniroute-peer-trace": "edge" },
        upstreamExtraHeaders: { "x-omniroute-peer-trace": "overridden" },
      });

      assert.equal(capturedTrace, "edge,gateway-a");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      if (previous.instanceId === undefined) delete process.env.OMNIROUTE_INSTANCE_ID;
      else process.env.OMNIROUTE_INSTANCE_ID = previous.instanceId;
      if (previous.peerUrls === undefined) delete process.env.OMNIROUTE_PEER_URLS;
      else process.env.OMNIROUTE_PEER_URLS = previous.peerUrls;
      if (previous.maxHops === undefined) delete process.env.OMNIROUTE_PEER_MAX_HOPS;
      else process.env.OMNIROUTE_PEER_MAX_HOPS = previous.maxHops;
    }
  });

  test("handleChat rejects a reciprocal peer loop before provider routing", async () => {
    const previous = process.env.OMNIROUTE_INSTANCE_ID;
    process.env.OMNIROUTE_INSTANCE_ID = "gateway-a";
    try {
      const response = await handleChat(
        new Request("http://gateway-a:20128/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-OmniRoute-Peer-Trace": "gateway-b,gateway-a",
          },
          body: JSON.stringify({
            model: "steady-free",
            messages: [{ role: "user", content: "ping" }],
          }),
        })
      );

      assert.equal(response.status, 508);
      assert.match(await response.text(), /peer routing loop detected/i);
    } finally {
      if (previous === undefined) delete process.env.OMNIROUTE_INSTANCE_ID;
      else process.env.OMNIROUTE_INSTANCE_ID = previous;
    }
  });
});

describe("chat-combo-model-authority-flow-12886", () => {
  /**
   * #12886 / #12899 — a restricted key may name a combo, while the concrete
   * target still has to pass every downstream policy check.
   */
  const COMBO = "combo-authority-flow-12886";
  const TARGET = "openai/gpt-4.1";

  async function resetStorage() {
    globalThis.fetch = originalFetch;
    await proxyLogger.flushProxyLogsSync();
    apiKeysDb.resetApiKeyState();
    await resetTestDb();
    fs.rmSync(TEST_DATA_DIR, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
    fs.mkdirSync(TEST_PLUGIN_DIR, { recursive: true });
  }

  beforeEach(async () => {
    await resetStorage();
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await proxyLogger.flushProxyLogsSync();
    apiKeysDb.resetApiKeyState();
    await resetTestDb();
  });

  async function seedNamedComboKey() {
    await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "openai-combo-authority-flow",
      apiKey: "sk-combo-authority-flow",
      isActive: true,
      testStatus: "active",
    });
    await combosDb.createCombo({
      name: COMBO,
      strategy: "priority",
      models: [TARGET],
    });
    const key = await apiKeysDb.createApiKey("Combo authority flow", "machine-12886");
    await apiKeysDb.updateApiKeyPermissions(key.id, { allowedModels: [COMBO] });
    return key;
  }

  function comboRequest(key: string, headers: Record<string, string> = {}) {
    return new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        ...headers,
      },
      body: JSON.stringify({
        model: COMBO,
        messages: [{ role: "user", content: "Reply with OK only." }],
        max_tokens: 16,
        stream: false,
      }),
    });
  }

  function upstreamResponse(content: string) {
    return Response.json({
      id: "chatcmpl-combo-authority-flow",
      choices: [{ message: { role: "assistant", content } }],
    });
  }

  test("named-combo allow-list reaches its configured concrete target through handleChat", async () => {
    const key = await seedNamedComboKey();
    let upstreamCalls = 0;
    globalThis.fetch = async () => {
      upstreamCalls += 1;
      return upstreamResponse("combo policy passed");
    };

    const response = await handleChat(comboRequest(key.key));
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    assert.equal(response.status, 200);
    assert.equal(upstreamCalls, 1);
    assert.equal(body.choices[0].message.content, "combo policy passed");
  });

  // A stored combo named in the key's allowedCombos (default `combo/*`) grants its
  // own targets, overriding blockedModels (#14197 — see the next test). The
  // live-test marker must still grant nothing when the combo is NOT granted.
  test("live-test marker does not let a non-granted named combo dispatch a blocked target", async () => {
    const key = await seedNamedComboKey();
    await apiKeysDb.updateApiKeyPermissions(key.id, {
      allowedCombos: ["other-combo"],
      blockedModels: [TARGET],
    });
    let upstreamCalls = 0;
    globalThis.fetch = async () => {
      upstreamCalls += 1;
      return upstreamResponse("must not dispatch");
    };

    const response = await handleChat(
      comboRequest(key.key, { "X-Internal-Test": "combo-health-check" })
    );

    assert.equal(response.status, 403);
    assert.equal(upstreamCalls, 0);
  });

  test("allowedCombos still grants a combo's blocked direct-model target at dispatch (#14197)", async () => {
    const key = await seedNamedComboKey();
    await apiKeysDb.updateApiKeyPermissions(key.id, {
      modelAccessMode: "restricted",
      allowedModels: ["gemini/*"],
      allowedCombos: [COMBO],
      blockedModels: [TARGET],
    });
    let upstreamCalls = 0;
    globalThis.fetch = async () => {
      upstreamCalls += 1;
      return upstreamResponse("explicit combo grant");
    };

    const response = await handleChat(comboRequest(key.key));
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    assert.equal(response.status, 200);
    assert.equal(upstreamCalls, 1);
    assert.equal(body.choices[0].message.content, "explicit combo grant");
  });
});

describe("chat-completions-route-shape-gate", () => {
  /**
   * Regression guard for the T06 route-validation gate on
   * `POST /api/v1/chat/completions` (`scripts/check/check-route-validation.mjs`).
   *
   * This is the hottest path in the proxy: the route already parses the body
   * exactly once (`parsedBody`) and threads it into `handleChat` without a second
   * `request.json()` call — the double parse doubled heap residency for large
   * coding-agent payloads and fed the OOM crash-loop in #4380/#7862. The T06 gate
   * flagged this file because it calls `request.json()` without a literal
   * `validateBody(`/`.safeParse(` call anywhere in the file.
   *
   * The fix adds `chatCompletionsRouteShapeSchema.safeParse()` INSIDE the route,
   * applied to the already-parsed `parsedBody` object (no new body read). The
   * schema is deliberately minimal — `model` a nullable string when present,
   * `messages` an array when present, `.passthrough()` for everything else — so
   * it can only reject shapes the deep validation in `src/sse/handlers/chat.ts`
   * would already reject with its own 400. These tests pin:
   *   - the body is still read exactly once (no new json()/clone() call);
   *   - a large, realistic payload still passes through;
   *   - shapes the deep pipeline accepts today (e.g. a `developer`-role message,
   *     or a request with `messages` but no `model`) are NOT newly rejected by
   *     the route-level gate;
   *   - shapes that were already a 400 stay a 400.
   */
  async function flushBackgroundWork() {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setImmediate(resolve));
  }

  async function resetStorage() {
    await resetTestDb();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  }

  beforeEach(async () => {
    globalThis.fetch = originalFetch;
    await resetStorage();
  });

  afterEach(async () => {
    await flushBackgroundWork();
    globalThis.fetch = originalFetch;
  });

  after(async () => {
    await flushBackgroundWork();
    globalThis.fetch = originalFetch;
    await core.resetDbInstance();
  });

  function makeCountingRequest(body: string) {
    const request = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    let jsonCalls = 0;
    let cloneCalls = 0;
    const originalJson = request.json.bind(request);
    const originalClone = request.clone.bind(request);

    Object.defineProperties(request, {
      json: {
        value: async () => {
          jsonCalls++;
          return originalJson();
        },
      },
      clone: {
        value: () => {
          cloneCalls++;
          return originalClone();
        },
      },
    });

    return {
      request,
      jsonCalls: () => jsonCalls,
      cloneCalls: () => cloneCalls,
    };
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // Malformed / structurally-invalid shapes still 400 (unchanged status)
  // ═════════════════════════════════════════════════════════════════════════════

  test("model as a number is rejected with 400 (matches the deep validation's own guard)", async () => {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: 12345,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const res = await chatRoute.POST(req);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: { message?: string } };
    assert.match(body.error?.message ?? "", /model/i);
  });

  test("messages as a non-array object is rejected with 400", async () => {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4.1",
        messages: { role: "user", content: "hi" },
      }),
    });
    const res = await chatRoute.POST(req);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: { message?: string } };
    assert.match(body.error?.message ?? "", /messages/i);
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // Shapes the deep pipeline already accepts must NOT become newly rejected
  // ═════════════════════════════════════════════════════════════════════════════

  test("a request with messages but no model is NOT rejected by the route-level gate (still fails later, at 'Missing model')", async () => {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const res = await chatRoute.POST(req);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: { message?: string } };
    // If the route-level gate had wrongly required `model`, this would read
    // something like "model: Required" instead of the pipeline's own message.
    assert.equal(body.error?.message, "Missing model");
  });

  test("model: null is NOT rejected by the route-level gate (passes through to deep resolution)", async () => {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: null,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const res = await chatRoute.POST(req);
    // Must not be rejected AS a type mismatch by the shape gate; may still 400
    // downstream as "Missing model" once `modelStr` resolves falsy, but never
    // with the shape gate's own "model: Expected string" message.
    const body = (await res.json()) as { error?: { message?: string } };
    assert.doesNotMatch(body.error?.message ?? "", /Expected string/);
  });

  test("a developer-role message is NOT rejected by the route-level gate (full round trip to 200)", async () => {
    await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "openai-shape-gate-dev-role",
      apiKey: "sk-shape-gate-dev-role",
      isActive: true,
      testStatus: "active",
    });

    globalThis.fetch = async () =>
      Response.json({
        id: "chatcmpl-shape-gate-dev-role",
        choices: [{ message: { role: "assistant", content: "OK" } }],
      });

    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4.1",
        messages: [
          { role: "developer", content: "Be concise." },
          { role: "user", content: "hi" },
        ],
        stream: false,
      }),
    });

    const res = await chatRoute.POST(req);
    const text = await res.text();
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${text.slice(0, 200)}`);
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // Large realistic payload: still accepted, body still read exactly once
  // ═════════════════════════════════════════════════════════════════════════════

  test("a large realistic payload is still accepted and the body is read exactly once", async () => {
    await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "openai-shape-gate-large-body",
      apiKey: "sk-shape-gate-large-body",
      isActive: true,
      testStatus: "active",
    });

    globalThis.fetch = async () =>
      Response.json({
        id: "chatcmpl-shape-gate-large-body",
        choices: [{ message: { role: "assistant", content: "OK" } }],
      });

    // ~300 KB of message content — representative of a coding-agent payload
    // (#4380's regression class), well past the large-body admission threshold.
    const largeContent = "x".repeat(300 * 1024);
    const largeBody = JSON.stringify({
      model: "openai/gpt-4.1",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: largeContent },
      ],
      stream: false,
    });

    const counting = makeCountingRequest(largeBody);
    const res = await chatRoute.POST(counting.request);
    const text = await res.text();

    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${text.slice(0, 200)}`);
    assert.equal(
      counting.jsonCalls(),
      0,
      "the ORIGINAL request must never be json()-parsed — admission ingests the bytes and " +
        "the route parses the admission-rebuilt request exactly once"
    );
    assert.equal(counting.cloneCalls(), 0, "the request body stream must not be teed/cloned");
  });
});

describe("chat-safetynet-reqid-6097", () => {
  // #6097 — Regression guard for the "safety-net combo redirect" ReferenceError.
  //
  // `handleSingleModelChat` (src/sse/handlers/chat.ts) contains a safety net: when
  // `resolveModelOrError` resolves the incoming model to a combo object (e.g. an
  // `auto/*` virtual combo), it redirects to `handleComboChat`. The argument object
  // it built used `correlationId: reqId`, but `reqId` is only defined in the SIBLING
  // `handleChat` scope — NOT inside `handleSingleModelChat`. Whenever that redirect
  // actually fired, the handler threw `ReferenceError: reqId is not defined`, which
  // surfaced to the client as a 502 `{"error":{"message":"reqId is not defined"}}`.
  //
  // The redirect is reached in practice when a persisted combo contains an `auto/*`
  // member: `handleComboChat` iterates the outer combo's targets and calls
  // `handleSingleModelChat("auto/fast", …)`; there `resolveModelOrError` discovers the
  // virtual auto-combo and takes the safety-net branch. (The top-level `handleChat`
  // combo lookup only sees the OUTER combo, so the auto member is only expanded one
  // layer deeper — exactly the "main handler's combo lookup missed it" case the code
  // comment describes.)
  //
  // The fix mirrors the 3 sibling call-sites: `correlationId: runtimeOptions?.correlationId ?? null`.
  //
  // This test drives the real /v1/chat/completions route with a nested-auto combo and
  // asserts the redirect completes (200 + real upstream dispatch) instead of throwing.
  // WITHOUT the fix it fails: 502 with the "reqId is not defined" body and zero fetches.
  async function flushBackgroundWork() {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise((resolve) => setImmediate(resolve));
  }

  async function resetStorage() {
    // Shared Postgres/one-process file: start from an empty database as the standalone file did.
    await resetTestDb();
    core.resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  }

  beforeEach(async () => {
    globalThis.fetch = originalFetch;
    await resetStorage();
  });

  afterEach(async () => {
    await flushBackgroundWork();
    globalThis.fetch = originalFetch;
  });

  after(async () => {
    await flushBackgroundWork();
    globalThis.fetch = originalFetch;
    core.resetDbInstance();
  });

  test("#6097 safety-net combo redirect does not throw ReferenceError: reqId is not defined", async () => {
    // A healthy provider connection so the inner auto/* combo has a candidate to
    // dispatch to once the safety-net redirect completes.
    await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "openai-safetynet-6097",
      apiKey: "sk-safetynet-6097",
      isActive: true,
      testStatus: "active",
    });

    // A persisted combo whose single member is a virtual `auto/*` combo. The
    // top-level handler resolves the OUTER combo; only when handleComboChat calls
    // handleSingleModelChat("auto/fast", …) does resolveModelOrError discover the
    // auto combo and fire the safety-net redirect.
    await combosDb.createCombo({
      name: "nested-auto-6097",
      strategy: "priority",
      models: [{ provider: "auto", model: "fast" }],
    });

    const fetchCalls: string[] = [];
    globalThis.fetch = async (url: any) => {
      fetchCalls.push(String(url));
      return Response.json({
        id: "chatcmpl-safetynet-6097",
        choices: [{ message: { role: "assistant", content: "OK" } }],
      });
    };

    const request = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Forces the combo target to be attempted (bypasses availability
        // pre-skipping) so the redirect path is exercised deterministically.
        "X-Internal-Test": "combo-health-check",
      },
      body: JSON.stringify({
        model: "nested-auto-6097",
        messages: [{ role: "user", content: "Reply with OK only." }],
        max_tokens: 16,
        stream: false,
        temperature: 0,
      }),
    });

    const response = await chatRoute.POST(request);
    const bodyText = await response.text();

    // Primary guard: the exact bug signature must never appear.
    assert.ok(
      !bodyText.includes("reqId is not defined"),
      `safety-net redirect leaked a ReferenceError: ${bodyText.slice(0, 200)}`
    );

    // The redirect must complete successfully (buggy version returned 502).
    assert.equal(
      response.status,
      200,
      `expected 200 after safety-net redirect, got ${response.status}: ${bodyText.slice(0, 200)}`
    );

    // And it must have proceeded past the redirect into a real upstream dispatch
    // (buggy version threw before any fetch → zero calls).
    assert.ok(
      fetchCalls.length > 0,
      "expected the redirected inner combo to reach a real upstream fetch"
    );

    const body = JSON.parse(bodyText) as any;
    assert.equal(body.choices[0].message.content, "OK");
  });
});

describe("qoder-pat-tools-13697", () => {
  const { createProviderConnection, deleteProviderConnectionsByProvider } = providersDb;

  before(async () => {
    // Start from an empty database and an existing data dir, as the standalone file did.
    await resetTestDb();
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  after(async () => {
    await resetTestDb();
  });

  test("transport detection preserves token precedence and legacy tool requests", () => {
    const credentials = {
      apiKey: " sk-http-fixture ",
      get accessToken(): string {
        throw new Error("a lower-priority token must not be materialized");
      },
    };
    assert.equal(resolveQoderAuthToken(credentials), "sk-http-fixture");
    assert.equal(qoderSupportsCallerTools(credentials), true);
    assert.equal(qoderSupportsCallerTools({ accessToken: " pt-oauth-fixture " }), false);
    assert.equal(qoderSupportsCallerTools({ refreshToken: "pt-refresh-fixture" }), false);
    assert.equal(hasQoderCallerTools({ functions: [{ name: "lookup" }] }), true);
    assert.equal(hasQoderCallerTools({ tools: [] }), false);
  });

  test("agent-required selection excludes PAT while plain chat retains the same account", async () => {
    await deleteProviderConnectionsByProvider("qoder");
    const pat = await createProviderConnection({
      provider: "qoder",
      authType: "apikey",
      name: "PAT",
      apiKey: "pt-fixture",
      isActive: true,
      providerSpecificData: { authMode: "pat", transport: "qodercli" },
    });
    const plain = await getProviderCredentials("qoder", null, [pat.id], "qwen3.8-max-preview");
    assert.equal(plain?.connectionId, pat.id);
    const tools = await getProviderCredentials("qoder", null, [pat.id], "qwen3.8-max-preview", {
      requireToolCalling: true,
    });
    assert.equal(tools, null);
  });

  test("agent-required selection retains an HTTP key in a mixed PAT/HTTP pool", async () => {
    await deleteProviderConnectionsByProvider("qoder");
    await createProviderConnection({
      provider: "qoder",
      authType: "apikey",
      name: "PAT first",
      apiKey: "pt-fixture",
      isActive: true,
      priority: 1,
    });
    const http = await createProviderConnection({
      provider: "qoder",
      authType: "apikey",
      name: "HTTP",
      apiKey: "sk-fixture-http",
      isActive: true,
      priority: 2,
    });
    const selected = await getProviderCredentials("qoder", null, null, "qwen3.8-max-preview", {
      requireToolCalling: true,
    });
    assert.equal(selected?.connectionId, http.id);
  });

  test("a PAT cooldown cannot make a tool request wait for an incompatible connection", async () => {
    await deleteProviderConnectionsByProvider("qoder");
    const pat = await createProviderConnection({
      provider: "qoder",
      authType: "apikey",
      name: "Cooling PAT",
      apiKey: "pt-cooling-fixture",
      isActive: true,
      rateLimitedUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    const selected = await getProviderCredentials("qoder", null, [pat.id], "qwen3.8-max-preview", {
      requireToolCalling: true,
    });
    assert.equal(selected, null);
  });

  test("PAT executor rejects caller tools before launching the local CLI", async () => {
    const previous = process.env.CLI_QODER_BIN;
    process.env.CLI_QODER_BIN = path.join(TEST_DATA_DIR, "missing-qodercli");
    try {
      const { response } = await new QoderExecutor().execute({
        model: "qwen3.8-max-preview",
        stream: false,
        credentials: { apiKey: "pt-fixture" },
        body: {
          messages: [{ role: "user", content: "Call lookup" }],
          tools: [
            { type: "function", function: { name: "lookup", parameters: { type: "object" } } },
          ],
        },
      });
      assert.equal(response.status, 400);
      const payload = await response.json();
      assert.equal(payload.error.code, "tool_calling_unsupported");
      assert.match(payload.error.message, /PAT.*tool/i);
      assert.doesNotMatch(payload.error.message, /pt-fixture/);
    } finally {
      if (previous === undefined) delete process.env.CLI_QODER_BIN;
      else process.env.CLI_QODER_BIN = previous;
    }
  });

  test("agent combo skips a pinned PAT leg without spawning CLI and reaches its tool-capable fallback", async () => {
    const { createCombo } = combosDb;
    await deleteProviderConnectionsByProvider("qoder");
    const pat = await createProviderConnection({
      provider: "qoder",
      authType: "apikey",
      name: "Pinned PAT",
      apiKey: "pt-fixture",
      isActive: true,
    });
    await createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "Fallback",
      apiKey: "sk-fixture-fallback",
      isActive: true,
    });
    await createCombo({
      name: "qoder-pat-agent-fixture",
      strategy: "priority",
      models: [
        { model: "qwen3.8-max-preview", provider: "qoder", connectionId: pat.id },
        "openai/gpt-4.1",
      ],
    });
    const previousFetch = globalThis.fetch;
    const previousBin = process.env.CLI_QODER_BIN;
    const marker = path.join(TEST_DATA_DIR, "cli-was-spawned");
    const stub = path.join(TEST_DATA_DIR, "qodercli");
    fs.writeFileSync(
      stub,
      '#!/bin/sh\ncat >/dev/null\ntouch "$QODER_TEST_MARKER"\nprintf \'%s\\n\' \'{"type":"result","is_error":false,"result":"plain text"}\'\n',
      { mode: 0o755 }
    );
    process.env.CLI_QODER_BIN = stub;
    process.env.QODER_TEST_MARKER = marker;
    let dispatchedTools = false;
    globalThis.fetch = async (input, init) => {
      assert.match(String(input), /api\.openai\.com/);
      dispatchedTools = Array.isArray(JSON.parse(String(init?.body)).tools);
      return Response.json({
        id: "chatcmpl-fixture",
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call-fixture",
                  type: "function",
                  function: { name: "lookup", arguments: "{}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      });
    };
    try {
      const response = await handleChat(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "qoder-pat-agent-fixture",
            stream: false,
            messages: [{ role: "user", content: "Call lookup" }],
            tools: [
              { type: "function", function: { name: "lookup", parameters: { type: "object" } } },
            ],
          }),
        })
      );
      const payload = await response.json();
      assert.equal(response.status, 200, JSON.stringify(payload));
      assert.equal(dispatchedTools, true);
      assert.equal(payload.choices[0].message.tool_calls[0].function.name, "lookup");
      assert.equal(fs.existsSync(marker), false);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousBin === undefined) delete process.env.CLI_QODER_BIN;
      else process.env.CLI_QODER_BIN = previousBin;
      delete process.env.QODER_TEST_MARKER;
      await flushProxyLogsSync();
    }
  });
});

describe("combo-avoid-stalled-account", () => {
  // A combo per-target timeout must steer the NEXT target of the same combo request away from
  // the account that stalled.
  //
  // Observed in production: priority combo `claude-opus-5.5` (claude/claude-opus-5-5, then
  // claude/claude-opus-5-5-high, same provider, several OAuth accounts, no pinned targets).
  // Account A accepted the stream and sent nothing; the per-target timer
  // (open-sse/services/combo/targetTimeoutRunner.ts) aborted target 1, and target 2 picked the
  // same account A again, so the request failed after twice the timeout.
  //
  // A combo target timeout stays request-scoped (no cooldown, lockout, breaker or
  // exhaustedConnections entry). Only the remaining targets of the SAME combo request prefer
  // another account, and fall back to the stalled one when it is the only eligible account.
  const TARGET_TIMEOUT_MS = 1_000;

  type Reply = "stall" | "silent-stream" | "ok" | "early-eof" | "server-error";

  const MESSAGE_START = {
    type: "message_start",
    message: {
      id: "msg-test",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [],
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  };

  function claudeStream(text: string): Response {
    const frames: Record<string, unknown>[] = [
      MESSAGE_START,
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 3 },
      },
      { type: "message_stop" },
    ];
    return new Response(
      frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
      { headers: { "Content-Type": "text/event-stream" } }
    );
  }

  /** HTTP 200 whose SSE body closes before a single event: an upstream error, not a stall. */
  function earlyEofStream(): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } }
    );
  }

  /** Accepts the request and never answers, until the dispatch is aborted. */
  function stalledUpstream(signal: AbortSignal | null | undefined): Promise<Response> {
    return new Promise((_resolve, reject) => {
      if (!signal) return;
      const onAbort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Opens the stream (message_start) and then sends nothing, until the dispatch is aborted. */
  function silentStream(signal: AbortSignal | null | undefined): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `event: message_start\ndata: ${JSON.stringify(MESSAGE_START)}\n\n`
            )
          );
          signal?.addEventListener(
            "abort",
            () => {
              try {
                controller.error(signal.reason);
              } catch {
                // Already cancelled by the reader.
              }
            },
            { once: true }
          );
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } }
    );
  }

  function stubClaude(plan: (token: string, attempt: number) => Reply): string[] {
    const dispatches: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes("/v1/messages")) {
        return new Response("{}", { headers: { "Content-Type": "application/json" } });
      }
      const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
      dispatches.push(token);
      const reply = plan(token, dispatches.length);
      if (reply === "stall") return stalledUpstream(init?.signal);
      if (reply === "silent-stream") return silentStream(init?.signal);
      if (reply === "early-eof") return earlyEofStream();
      if (reply === "server-error") {
        return new Response(
          JSON.stringify({
            type: "error",
            error: { type: "api_error", message: "Internal error" },
          }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
      return claudeStream(`OK-${token}`);
    };
    return dispatches;
  }

  async function seedClaudeAccount(name: string): Promise<{ id: string; token: string }> {
    const token = `test-${name}`;
    const row = await providersDb.createProviderConnection({
      provider: "claude",
      authType: "oauth",
      name,
      accessToken: token,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      isActive: true,
      testStatus: "active",
    });
    return { id: String(row.id), token };
  }

  async function createOpusCombo(
    name: string,
    targetTimeoutMs = TARGET_TIMEOUT_MS
  ): Promise<string> {
    await combosDb.createCombo({
      name,
      strategy: "priority",
      models: ["claude/claude-opus-5-5", "claude/claude-opus-5-5-high"],
      config: {
        maxRetries: 0,
        retryDelayMs: 0,
        fallbackDelayMs: 0,
        targetTimeoutMs,
      },
    });
    return name;
  }

  function comboRequest(model: string): Request {
    return new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: `Reply OK. ${crypto.randomUUID()}` }],
        stream: true,
        max_tokens: 64,
      }),
    });
  }

  beforeEach(async () => {
    clearInflight();
    resetAllCircuitBreakers();
    initTranslators();
    // fill-first always hands out the first account, exactly like the production account that
    // carries most of the traffic, so only the stalled-account preference can move target 2.
    await settingsDb.updateSettings({ fallbackStrategy: "fill-first", autoDbBackup: false });
  });

  async function resetTestState(): Promise<void> {
    globalThis.fetch = originalFetch;
    await callLogs.waitForCallLogSaves(2000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    flushProxyLogsSync();
    clearInflight();
    await resetTestDb();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  }

  // The per-target timer starts before the first request has loaded the cold request path. One
  // warm-up combo request (generous timeout, result ignored) keeps that out of every stall test.
  before(async () => {
    await resetTestDb();
    initTranslators();
    await settingsDb.updateSettings({ fallbackStrategy: "fill-first", autoDbBackup: false });
    await seedClaudeAccount("warm-up");
    stubClaude(() => "ok");
    const warmUp = await handleChat(
      comboRequest(await createOpusCombo("stall-avoid-warm-up", 30_000))
    );
    await warmUp.text();
    await resetTestState();
  });

  afterEach(resetTestState);

  after(async () => {
    globalThis.fetch = originalFetch;
  });

  test("after a combo target timeout on account A, the next same-provider target uses account B", async () => {
    const a = await seedClaudeAccount("stall-a");
    const b = await seedClaudeAccount("stall-b");
    const combo = await createOpusCombo("stall-avoid-two-accounts");
    const dispatches = stubClaude((token) => (token === a.token ? "stall" : "ok"));

    const response = await handleChat(comboRequest(combo));
    const body = await response.text();

    assert.equal(response.status, 200, body);
    assert.deepEqual(
      dispatches,
      [a.token, b.token],
      "target 2 must not be handed the account that just stalled target 1"
    );
    assert.match(body, new RegExp(`OK-${b.token}`));
    assert.equal(response.headers.get("X-OmniRoute-Selected-Connection-Id"), b.id);
  });

  test("only the account in flight when the timer fires is avoided, not one that failed earlier in the target", async () => {
    const a = await seedClaudeAccount("in-flight-a");
    const b = await seedClaudeAccount("in-flight-b");
    await seedClaudeAccount("in-flight-c");
    const combo = await createOpusCombo("stall-avoid-in-flight-only");
    // Target 1: A fails fast, chat.ts moves on to B inside the same target, and B stalls.
    const dispatches = stubClaude((token, attempt) => {
      if (token === b.token) return "stall";
      return token === a.token && attempt === 1 ? "server-error" : "ok";
    });

    const response = await handleChat(comboRequest(combo));
    const body = await response.text();

    assert.equal(response.status, 200, body);
    assert.deepEqual(
      dispatches,
      [a.token, b.token, a.token],
      "target 2 avoids B (stalled) but may still use A, whose failure was not a timeout"
    );
    assert.equal(response.headers.get("X-OmniRoute-Selected-Connection-Id"), a.id);
  });

  test("an account that opens the stream but never produces output is also avoided by the next target", async () => {
    const a = await seedClaudeAccount("silent-a");
    const b = await seedClaudeAccount("silent-b");
    const combo = await createOpusCombo("stall-avoid-silent-stream");
    const dispatches = stubClaude((token) => (token === a.token ? "silent-stream" : "ok"));

    const response = await handleChat(comboRequest(combo));
    const body = await response.text();

    assert.equal(response.status, 200, body);
    assert.deepEqual(dispatches, [a.token, b.token]);
    assert.match(body, new RegExp(`OK-${b.token}`));
  });

  test("with no other eligible account, the next target still falls back to the stalled one", async () => {
    const a = await seedClaudeAccount("only-a");
    const combo = await createOpusCombo("stall-avoid-single-account");
    const dispatches = stubClaude((_token, attempt) => (attempt === 1 ? "stall" : "ok"));

    const response = await handleChat(comboRequest(combo));
    const body = await response.text();

    assert.equal(response.status, 200, body);
    assert.deepEqual(dispatches, [a.token, a.token], "a singleton pool keeps its only account");
    assert.match(body, new RegExp(`OK-${a.token}`));
  });

  test("an upstream error on account A (not a timeout) does not steer the next target away from A", async () => {
    const a = await seedClaudeAccount("eof-a");
    await seedClaudeAccount("eof-b");
    const combo = await createOpusCombo("stall-avoid-non-timeout-error");
    // Target 1: early EOF plus its one bounded same-account retry; target 2: healthy.
    const dispatches = stubClaude((_token, attempt) => (attempt <= 2 ? "early-eof" : "ok"));

    const response = await handleChat(comboRequest(combo));
    const body = await response.text();

    assert.equal(response.status, 200, body);
    assert.equal(dispatches.length, 3, `unexpected dispatches: ${dispatches.join(",")}`);
    assert.deepEqual(
      dispatches,
      [a.token, a.token, a.token],
      "only a combo per-target timeout may make later targets avoid an account"
    );
  });

  test("the stalled-account preference does not leak into a later combo request", async () => {
    const a = await seedClaudeAccount("leak-a");
    const b = await seedClaudeAccount("leak-b");
    const combo = await createOpusCombo("stall-avoid-no-leak");
    let stallA = true;
    const dispatches = stubClaude((token) => (token === a.token && stallA ? "stall" : "ok"));

    const first = await handleChat(comboRequest(combo));
    const firstBody = await first.text();
    assert.equal(first.status, 200, firstBody);
    assert.deepEqual(dispatches, [a.token, b.token]);

    stallA = false;
    dispatches.length = 0;
    const second = await handleChat(comboRequest(combo));
    const secondBody = await second.text();

    assert.equal(second.status, 200, secondBody);
    assert.deepEqual(dispatches, [a.token], "a fresh combo request starts from the usual account");
    assert.equal(second.headers.get("X-OmniRoute-Selected-Connection-Id"), a.id);
  });

  // ── The watch itself: which aborts count as a stall ─────────────────────────

  const quietLog = { info() {}, warn() {}, debug() {}, error() {} };

  /**
   * Run one target through the real per-target timeout runner, with the combo request signal
   * merged in the way safetyStopLatch.ts does before chat.ts sees `modelAbortSignal`.
   */
  async function runWatchedTarget(
    stalled: Map<string, string>,
    dispatch: (signal: AbortSignal) => Promise<Response>
  ): Promise<Response> {
    const requestSignal = new AbortController().signal;
    const run = buildTargetTimeoutRunner({
      comboTargetTimeoutMs: 40,
      log: quietLog,
      handleSingleModel: async (_body, _model, target) => {
        const signal = AbortSignal.any([requestSignal, target!.modelAbortSignal!]);
        stalledConnections.watchComboTargetStall(stalled, signal, "claude", "conn-a");
        return dispatch(signal);
      },
    });
    return run({ messages: [{ role: "user", content: "ping" }] }, "claude/claude-opus-5-5");
  }

  test("the runner's dispatch timer and first-output gate both record the stalled account", async () => {
    const timedOut = new Map<string, string>();
    const viaTimer = await runWatchedTarget(timedOut, (signal) => stalledUpstream(signal));
    assert.equal(viaTimer.status, 504);
    assert.deepEqual([...timedOut], [["conn-a", "claude"]]);

    const silent = new Map<string, string>();
    const viaGate = await runWatchedTarget(silent, async (signal) => silentStream(signal));
    assert.equal(viaGate.status, 504);
    assert.deepEqual([...silent], [["conn-a", "claude"]]);
  });

  test("hedge cancellation, client disconnect and success never record the account", async () => {
    const stalled = new Map<string, string>();
    const client = new AbortController();
    const hedged = new AbortController();
    stalledConnections.watchComboTargetStall(
      stalled,
      AbortSignal.any([client.signal, hedged.signal]),
      "claude",
      "conn-hedged"
    );
    hedged.abort(new Error(COMBO_HEDGE_CANCELLED_REASON));

    const disconnected = new AbortController();
    stalledConnections.watchComboTargetStall(stalled, disconnected.signal, "claude", "conn-client");
    disconnected.abort();

    const succeeded = await runWatchedTarget(stalled, async () => claudeStream("fast"));
    assert.equal(succeeded.status, 200);
    await succeeded.text();

    assert.equal(stalled.size, 0);
  });

  test("a dispatch that failed for another reason is not blamed for a later timeout", () => {
    const stalled = new Map<string, string>();
    const target = new AbortController();
    const stop = stalledConnections.watchComboTargetStall(
      stalled,
      target.signal,
      "claude",
      "conn-a"
    );
    stop(); // upstream error on conn-a; chat.ts moves on to another account
    target.abort(new Error(COMBO_PER_MODEL_TIMEOUT_REASON));
    assert.equal(stalled.size, 0);

    const alreadyAborted = new AbortController();
    alreadyAborted.abort(new Error(COMBO_PER_MODEL_TIMEOUT_REASON));
    stalledConnections.watchComboTargetStall(stalled, alreadyAborted.signal, "claude", "conn-b");
    assert.equal(stalled.size, 0, "an abort before this dispatch started is not this account's");
  });

  test("stalled accounts only steer selection for their own provider", () => {
    const stalled = new Map([
      ["conn-claude", "claude"],
      ["conn-codex", "codex"],
    ]);
    assert.deepEqual(stalledConnections.comboStalledConnectionIds(stalled, "claude"), [
      "conn-claude",
    ]);
    assert.deepEqual(stalledConnections.comboStalledConnectionIds(stalled, "openai"), []);
    assert.deepEqual(stalledConnections.comboStalledConnectionIds(null, "claude"), []);
  });
});
