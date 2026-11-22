// handleChat (the chat route handler) driven end to end through the shared chat-pipeline
// harness: suffix reasoning-effort propagation and chat-route edge cases.
//
// Merged from 2 files that each built the same harness, so the chat handler and chatCore
// module graphs load once per process. Each `describe` below is one former file (its name is
// the old file name without `.test.ts`). They share one harness instance, which sets its
// load-time env (REQUIRE_API_KEY=false, empty dashboard passwords, no JWT_SECRET, an
// API_KEY_SECRET) before importing the app; that env is why these stay out of the plain
// handleChatCore files in this folder.
import test, { after, afterEach, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

const networkFetch = globalThis.fetch;

import { createChatPipelineHarness } from "../../integration/_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("chat-route-pipeline");
const {
  BaseExecutor,
  buildOpenAIResponse,
  buildRequest,
  combosDb,
  handleChat,
  resetStorage,
  seedConnection,
} = harness;
const { persistDiscoveredModels } =
  await import("../../../src/lib/providerModels/modelDiscovery.ts");
const { resolveModelOrError } = await import("../../../src/sse/handlers/chatHelpers.ts");
const { setBackgroundDegradationConfig } =
  await import("../../../open-sse/services/backgroundTaskDetector.ts");
const { setCustomAliases } = await import("../../../open-sse/services/modelDeprecation.ts");
const { setModelAlias } = await import("../../../src/lib/db/models.ts");

after(async () => {
  await harness.cleanup();
});

describe("suffix-effort-propagation", () => {
  const MODEL = "agnes-3.0-flash";

  beforeEach(async () => {
    await resetStorage();
    const connection = await seedConnection("agnes");
    await persistDiscoveredModels("agnes", connection.id, [
      { id: MODEL, reasoning: { supported_efforts: ["none", "low", "high", "max"] } },
    ]);
  });

  after(() => {
    globalThis.fetch = networkFetch;
  });

  test("resolution retains the validated suffix effort", async () => {
    const result = await resolveModelOrError(`agnes/${MODEL}-max`, {
      messages: [{ role: "user", content: "hello" }],
    });
    assert.equal(result.model, MODEL);
    assert.equal(result.resolvedThinkingEffort, "max");
  });

  for (const combo of [false, true]) {
    for (const effort of ["none", "max"]) {
      test(`${combo ? "combo" : "direct"} ${effort} suffix reaches the upstream body`, async () => {
        const target = `agnes/${MODEL}-${effort}`;
        const model = combo ? "suffix-effort-combo" : target;
        if (combo) {
          await combosDb.createCombo({ name: model, strategy: "priority", models: [target] });
        }
        const bodies: Record<string, unknown>[] = [];
        globalThis.fetch = async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return buildOpenAIResponse("The requested calculation is complete.", MODEL);
        };
        const response = await handleChat(
          buildRequest({
            body: {
              model,
              stream: false,
              messages: [{ role: "user", content: "Compute a short example." }],
            },
          })
        );
        assert.equal(response.status, 200, await response.text());
        assert.equal(bodies.length, 1);
        assert.equal(bodies[0].model, MODEL);
        assert.equal(bodies[0].reasoning_effort, effort);
      });
    }
  }

  test("explicit client effort still takes precedence over the suffix", async () => {
    let sent: Record<string, unknown> | undefined;
    globalThis.fetch = async (_input, init) => {
      sent = JSON.parse(String(init?.body));
      return buildOpenAIResponse("The requested calculation is complete.", MODEL);
    };
    const response = await handleChat(
      buildRequest({
        body: {
          model: `agnes/${MODEL}-max`,
          stream: false,
          reasoning_effort: "low",
          messages: [{ role: "user", content: "Compute a short example." }],
        },
      })
    );
    assert.equal(response.status, 200, await response.text());
    assert.equal(sent?.reasoning_effort, "low");
  });

  for (const choice of [{ reasoning: false }, { thinking: { type: "disabled" } }, {}]) {
    test(`unsuffixed or explicit reasoning stays unchanged: ${JSON.stringify(choice)}`, async () => {
      let sent: Record<string, unknown> | undefined;
      globalThis.fetch = async (_input, init) => {
        sent = JSON.parse(String(init?.body));
        return buildOpenAIResponse("The requested calculation is complete.", MODEL);
      };
      const response = await handleChat(
        buildRequest({
          body: {
            model: `agnes/${MODEL}${Object.keys(choice).length ? "-max" : ""}`,
            stream: false,
            ...choice,
            messages: [{ role: "user", content: "Compute a short example." }],
          },
        })
      );
      assert.equal(response.status, 200, await response.text());
      assert.equal(sent?.reasoning_effort, undefined);
      for (const [field, value] of Object.entries(choice)) assert.deepEqual(sent?.[field], value);
    });
  }

  async function sendBareAliasWithConnectionDefault(): Promise<
    Record<string, unknown> | undefined
  > {
    await harness.resetStorage();
    const connection = await seedConnection("agnes");
    const { updateProviderConnection } = await import("../../../src/lib/db/providers.ts");
    await updateProviderConnection(String(connection.id), {
      defaultModel: "agnes-default-replacement",
    });
    await persistDiscoveredModels("agnes", String(connection.id), [
      { id: MODEL, reasoning: { supported_efforts: ["high", "max"] } },
    ]);
    await harness.settingsDb.updateSettings({
      modelAliases: { "bare-effort-alias": `agnes/${MODEL}-max` },
    });
    let sent: Record<string, unknown> | undefined;
    globalThis.fetch = async (_input, init) => {
      sent = JSON.parse(String(init?.body));
      return buildOpenAIResponse("The replacement answered.", "agnes-default-replacement");
    };
    const resolved = await resolveModelOrError("bare-effort-alias", {
      messages: [{ role: "user", content: "hello" }],
    });
    assert.equal(resolved.resolvedThinkingEffort, "max");
    const response = await handleChat(
      buildRequest({
        body: {
          model: "bare-effort-alias",
          stream: false,
          messages: [{ role: "user", content: "Compute a short example." }],
        },
      })
    );
    assert.equal(response.status, 200, await response.text());
    return sent;
  }

  test("a bare alias keeps its concrete target and suffix effort over a connection default", async () => {
    const sent = await sendBareAliasWithConnectionDefault();
    assert.equal(sent?.model, MODEL);
    assert.equal(sent?.reasoning_effort, "max");
  });

  test("connection default replacement does not inherit a bare alias suffix", async () => {
    // The default only replaces a concrete bare model under the legacy override.
    const before = process.env.BARE_MODEL_DEFAULT_OVERRIDE_LEGACY;
    process.env.BARE_MODEL_DEFAULT_OVERRIDE_LEGACY = "true";
    try {
      const sent = await sendBareAliasWithConnectionDefault();
      assert.equal(sent?.model, "agnes-default-replacement");
      assert.equal(sent?.reasoning_effort, undefined);
    } finally {
      if (before === undefined) delete process.env.BARE_MODEL_DEFAULT_OVERRIDE_LEGACY;
      else process.env.BARE_MODEL_DEFAULT_OVERRIDE_LEGACY = before;
    }
  });

  test("a different combo provider does not inherit the original suffix", async () => {
    await seedConnection("openai");
    await combosDb.createCombo({
      name: "redirect-effort",
      strategy: "priority",
      models: [
        { id: "redirect", kind: "model", providerId: "openai", model: `agnes/${MODEL}-max` },
      ],
    });
    let sent: Record<string, unknown> | undefined;
    globalThis.fetch = async (_input, init) => {
      sent = JSON.parse(String(init?.body));
      return buildOpenAIResponse("The requested calculation is complete.", MODEL);
    };
    const response = await handleChat(
      buildRequest({
        body: {
          model: "redirect-effort",
          stream: false,
          messages: [{ role: "user", content: "Compute a short example." }],
        },
      })
    );
    assert.equal(response.status, 200, await response.text());
    assert.equal(sent?.reasoning_effort, undefined);
  });

  for (const redirect of ["background", "alias"]) {
    for (const explicit of [false, true]) {
      test(`${redirect} replacement drops suffix but preserves explicit effort: ${explicit}`, async () => {
        const replacement = "agnes-review-cheap";
        let sent: Record<string, unknown> | undefined;
        globalThis.fetch = async (_input, init) => {
          sent = JSON.parse(String(init?.body));
          return buildOpenAIResponse("The requested calculation is complete.", replacement);
        };
        try {
          if (redirect === "background") {
            setBackgroundDegradationConfig({
              enabled: true,
              degradationMap: { [MODEL]: replacement },
            });
          } else {
            setCustomAliases({ [MODEL]: replacement });
          }
          const response = await handleChat(
            buildRequest({
              headers: redirect === "background" ? { "x-task-type": "background" } : {},
              body: {
                model: `agnes/${MODEL}-max`,
                stream: false,
                ...(explicit ? { reasoning_effort: "low" } : {}),
                messages: [{ role: "user", content: "Compute a short example." }],
              },
            })
          );
          assert.equal(response.status, 200, await response.text());
          assert.equal(sent?.model, replacement);
          assert.equal(sent?.reasoning_effort, explicit ? "low" : undefined);
        } finally {
          setBackgroundDegradationConfig({ enabled: false, degradationMap: {} });
          setCustomAliases({});
        }
      });
    }
  }

  for (const failure of ["empty"]) {
    for (const mode of ["plain", "explicit", "suffix"]) {
      test(`${failure} family fallback preserves only explicit effort: ${mode}`, async () => {
        const provider = "cheaperinference";
        const model = "claude-sonnet-4.6";
        const fallback = "claude-sonnet-4.5";
        const connection = await seedConnection(provider);
        await persistDiscoveredModels(provider, connection.id, [
          { id: model, reasoning: { supported_efforts: ["low", "high"] } },
          { id: fallback, reasoning: { supported_efforts: ["low", "high"] } },
        ]);
        const bodies: Record<string, unknown>[] = [];
        globalThis.fetch = async (_url, init) => {
          const sent = JSON.parse(String(init?.body));
          bodies.push(sent);
          if (sent.model === model) return buildOpenAIResponse("", model);
          return buildOpenAIResponse("The requested example is complete.", sent.model);
        };
        const response = await handleChat(
          buildRequest({
            // #16810: a cross-version family hop (4.6 → 4.5) only runs when the caller opts in.
            headers: { "x-omniroute-allow-cross-version-fallback": "true" },
            body: {
              model: `${provider}/${model}${mode === "suffix" ? "-high" : ""}`,
              stream: false,
              ...(mode === "explicit" ? { reasoning_effort: "low" } : {}),
              messages: [{ role: "user", content: "Explain a small example." }],
            },
          })
        );
        assert.equal(response.status, 200, await response.text());
        assert.equal(bodies[0].model, model);
        assert.equal(bodies.at(-1)?.model, fallback);
        assert.equal(
          bodies[0].reasoning_effort,
          mode === "suffix" ? "high" : mode === "explicit" ? "low" : undefined
        );
        assert.equal(bodies.at(-1)?.reasoning_effort, mode === "explicit" ? "low" : undefined);
      });
    }
  }

  test("server tool follow-up materializes suffix effort on the fresh translated transcript", async () => {
    const apiKey = await harness.seedApiKey();
    await harness.settingsDb.updateSettings({ skillsEnabled: true });
    const { encodeSkillToolName } = await import("../../../src/lib/skills/injection.ts");
    harness.skillExecutor.registerHandler("attempt-weather", async () => ({ forecast: "sunny" }));
    await harness.skillRegistry.register({
      apiKeyId: apiKey.id,
      name: "lookupWeather",
      version: "1.0.0",
      description: "Weather fixture",
      schema: {
        input: { type: "object", properties: { location: { type: "string" } } },
        output: { type: "object" },
      },
      handler: "attempt-weather",
      enabled: true,
    });
    const previous = process.env.SERVER_OWNED_TOOL_LOOP_ENABLED;
    process.env.SERVER_OWNED_TOOL_LOOP_ENABLED = "true";
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = async (_input, init) => {
      const sent = JSON.parse(String(init?.body));
      bodies.push(sent);
      if (bodies.length === 1)
        return harness.buildOpenAIToolCallResponse({
          model: MODEL,
          toolCallId: "attempt-weather-call",
          toolName: encodeSkillToolName("lookupWeather", "1.0.0"),
          argumentsObject: { location: "Tokyo" },
        });
      return buildOpenAIResponse("The weather is sunny.", MODEL);
    };
    try {
      const response = await handleChat(
        buildRequest({
          authKey: apiKey.key,
          body: {
            model: `agnes/${MODEL}-high`,
            stream: false,
            messages: [{ role: "user", content: "Use lookupWeather for Tokyo." }],
          },
        })
      );
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.choices[0].message.content, "The weather is sunny.");
      assert.equal(bodies.length, 2);
      assert.equal(bodies[0].reasoning_effort, "high");
      assert.equal(bodies[1].reasoning_effort, "high");
      const messages = bodies[1].messages as Array<Record<string, unknown>>;
      assert.ok(
        messages.some(
          (message) => message.role === "tool" && message.tool_call_id === "attempt-weather-call"
        )
      );
    } finally {
      if (previous === undefined) delete process.env.SERVER_OWNED_TOOL_LOOP_ENABLED;
      else process.env.SERVER_OWNED_TOOL_LOOP_ENABLED = previous;
    }
  });

  test("streaming direct refresh retry prepares effort after the pipeline refresh was exhausted", async () => {
    const { handleChatCore } = await import("../../../open-sse/handlers/chatCore.ts");
    const bodies: Record<string, unknown>[] = [];
    const headers: Headers[] = [];
    let refreshes = 0;
    globalThis.fetch = async (input, init) => {
      if (String(input).startsWith("https://api.github.com/copilot_internal/v2/token")) {
        refreshes++;
        modelInfo.model = "mutated-caller-model";
        modelInfo.resolvedThinkingEffort = "low";
        return Response.json({
          token: `fixture-refresh-${refreshes}`,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        });
      }
      bodies.push(JSON.parse(String(init?.body)));
      headers.push(new Headers(init?.headers));
      if (bodies.length < 3)
        return Response.json({ error: { message: "Expired token" } }, { status: 401 });
      return new Response(
        `data: ${JSON.stringify({ id: "refresh-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Refresh succeeded." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } }
      );
    };
    const modelInfo = { provider: "github", model: "gpt-4o-mini", resolvedThinkingEffort: "high" };
    const result = await handleChatCore({
      body: {
        model: "gpt-4o-mini",
        stream: true,
        messages: [{ role: "user", content: "Exercise refresh retry." }],
      },
      modelInfo,
      credentials: {
        accessToken: "fixture-access",
        refreshToken: "fixture-refresh",
        providerSpecificData: { copilotToken: "fixture-initial" },
      },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      onCredentialsRefreshed: async () => {},
      onRequestSuccess: undefined,
      onStreamFailure: undefined,
      onDisconnect: undefined,
      clientRawRequest: undefined,
      connectionId: undefined,
      userAgent: undefined,
      comboName: undefined,
    });
    assert.ok(!(result instanceof Response));
    assert.equal(result.success, true);
    assert.match(await result.response.text(), /Refresh succeeded/);
    assert.equal(bodies.length, 3);
    assert.equal(refreshes, 2);
    for (const body of bodies) assert.equal(body.reasoning_effort, "high");
    assert.equal(headers[2].get("authorization"), "Bearer fixture-refresh-2");
  });

  for (const pair of [
    ["high", "high"],
    ["low", "high"],
  ]) {
    test(`overlapping suffix requests ${pair.join("/")} preserve dedup identity over HTTP`, async () => {
      const bodies: Record<string, unknown>[] = [];
      const server = createServer(async (req, res) => {
        let text = "";
        for await (const chunk of req) text += chunk;
        const sent = JSON.parse(text);
        bodies.push(sent);
        await new Promise((resolve) => setTimeout(resolve, 350));
        res.setHeader("Content-Type", "application/json");
        res.end(
          await buildOpenAIResponse(`Completed with ${sent.reasoning_effort} effort.`, MODEL).text()
        );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      try {
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        globalThis.fetch = (_input, init) =>
          networkFetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, init);
        const responses = await Promise.all(
          pair.map((effort) =>
            handleChat(
              buildRequest({
                body: {
                  model: `agnes/${MODEL}-${effort}`,
                  stream: false,
                  temperature: 0,
                  messages: [{ role: "user", content: "Compute an overlapping example." }],
                },
              })
            )
          )
        );
        for (const [index, response] of responses.entries()) {
          assert.equal(response.status, 200);
          const payload = await response.json();
          assert.equal(payload.choices[0].message.content, `Completed with ${pair[index]} effort.`);
        }
        assert.equal(bodies.length, pair[0] === pair[1] ? 1 : 2);
        assert.deepEqual(bodies.map((b) => b.reasoning_effort).sort(), [...new Set(pair)].sort());
        for (const body of bodies) {
          assert.equal(body.originModel, undefined);
          assert.equal(body.resolvedThinkingEffort, undefined);
          assert.equal(body.defaultThinkingEffort, undefined);
          assert.equal(body.trustedContext, undefined);
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
    });
  }

  for (const pair of [
    ["high", "none"],
    ["none", "high"],
    ["high", "high"],
  ]) {
    test(`overlapping explicit requests ${pair.join("/")} preserve responses over HTTP`, async () => {
      const { handleChatCore } = await import("../../../open-sse/handlers/chatCore.ts");
      const bodies: Record<string, unknown>[] = [];
      let firstArrived!: () => void;
      const arrival = new Promise<void>((resolve) => {
        firstArrived = resolve;
      });
      const server = createServer(async (req, res) => {
        let text = "";
        for await (const chunk of req) text += chunk;
        const sent = JSON.parse(text);
        bodies.push(sent);
        firstArrived();
        await new Promise((resolve) => setTimeout(resolve, 800));
        res.setHeader("Content-Type", "application/json");
        res.end(
          await buildOpenAIResponse(
            `Completed with ${sent.reasoning_effort} effort.`,
            "gpt-5.2"
          ).text()
        );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const savedFetch = globalThis.fetch;
      try {
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        globalThis.fetch = (_input, init) =>
          networkFetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, init);
        const send = (reasoning_effort: string) =>
          handleChatCore({
            body: {
              model: "gpt-5.2",
              stream: false,
              temperature: 0,
              reasoning_effort,
              messages: [{ role: "user", content: "Compute an overlapping explicit example." }],
            },
            modelInfo: { provider: "openai", model: "gpt-5.2" },
            credentials: { apiKey: "fixture-explicit-local" },
            log: { debug() {}, info() {}, warn() {}, error() {} },
            onCredentialsRefreshed: undefined,
            onRequestSuccess: undefined,
            onStreamFailure: undefined,
            onDisconnect: undefined,
            clientRawRequest: undefined,
            connectionId: undefined,
            userAgent: undefined,
            comboName: undefined,
          });
        const first = send(pair[0]);
        await arrival;
        const results = await Promise.all([first, send(pair[1])]);
        for (const [index, result] of results.entries()) {
          const response = result instanceof Response ? result : result.response;
          assert.equal(response.status, 200);
          const payload = await response.json();
          assert.equal(payload.choices[0].message.content, `Completed with ${pair[index]} effort.`);
        }
        assert.equal(bodies.length, pair[0] === pair[1] ? 1 : 2);
        assert.deepEqual(
          bodies.map((b) => b.reasoning_effort),
          [...new Set(pair)]
        );
        for (const body of bodies) {
          assert.equal(body.temperature, body.reasoning_effort === "high" ? undefined : 0);
          assert.equal(body.requestIntent, undefined);
          assert.equal(body.trustedContext, undefined);
        }
      } finally {
        globalThis.fetch = savedFetch;
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
    });
  }

  for (const accountFallback of [false, true]) {
    test(`max suffix survives ${accountFallback ? "account fallback" : "same-account retry"} over HTTP`, async () => {
      await seedConnection("agnes", { name: "agnes-backup", priority: 2 });
      const bodies: Record<string, unknown>[] = [];
      const identities = new Map<string, number>();
      const accountOrdinals: number[] = [];
      const server = createServer(async (req, res) => {
        const auth = String(req.headers.authorization || "");
        if (!identities.has(auth)) identities.set(auth, identities.size + 1);
        accountOrdinals.push(identities.get(auth)!);
        let text = "";
        for await (const chunk of req) text += chunk;
        bodies.push(JSON.parse(text));
        res.setHeader("Content-Type", "application/json");
        if (accountFallback ? identities.get(auth) === 1 : bodies.length === 1) {
          res.writeHead(429);
          res.end(JSON.stringify({ error: { message: "Rate limit exceeded" } }));
        } else {
          res.end(
            await buildOpenAIResponse("The requested calculation is complete.", MODEL).text()
          );
        }
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      try {
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        globalThis.fetch = (_input, init) =>
          networkFetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, init);
        const response = await handleChat(
          buildRequest({
            body: {
              model: `agnes/${MODEL}-max`,
              stream: false,
              messages: [{ role: "user", content: "Compute a short example." }],
            },
          })
        );
        assert.equal(response.status, 200, await response.text());
        assert.ok(!identities.has(""), "all requests must carry a credential");
        assert.equal(identities.size, accountFallback ? 2 : 1);
        assert.equal(accountOrdinals[0], 1);
        assert.equal(accountOrdinals.at(-1), accountFallback ? 2 : 1);
        if (!accountFallback) assert.equal(bodies.length, 2);
        for (const body of bodies) {
          assert.equal(body.model, MODEL);
          assert.equal(body.reasoning_effort, "max");
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
    });
  }
});

describe("chat-route-edge-cases", () => {
  beforeEach(async () => {
    BaseExecutor.RETRY_CONFIG.delayMs = 0;
    await resetStorage();
  });

  afterEach(async () => {
    await resetStorage();
  });

  after(() => {
    BaseExecutor.RETRY_CONFIG.delayMs = harness.originalRetryDelayMs;
  });

  test("handleChat resolves model alias before routing", async () => {
    await seedConnection("openai", { apiKey: "sk-openai" });
    // setModelAlias writes to key_value namespace='modelAliases', which is the
    // namespace that getModelAliases() (used by getModelInfo in chatCore) reads from.
    // settingsDb.updateSettings({ modelAliases }) writes to namespace='settings' and
    // triggers setCustomAliases (in-memory only) — a separate store not consulted here.
    await setModelAlias("alias-model", "openai/gpt-4.1");

    const seenModels = [];
    globalThis.fetch = async (_url, init = {}) => {
      try {
        const body = JSON.parse(String(init.body));
        seenModels.push(body.model);
      } catch {}
      return buildOpenAIResponse("Alias response");
    };

    const response = await handleChat(
      buildRequest({
        body: {
          model: "alias-model",
          stream: false,
          messages: [{ role: "user", content: "Test alias" }],
        },
      })
    );

    assert.equal(response.status, 200, "Should succeed with 200 OK");
    assert.equal(seenModels[0], "gpt-4.1", "Model alias should be resolved to gpt-4.1");
  });

  test("handleChat strips client context-window tags before combo routing and dispatch", async () => {
    await seedConnection("openai", { apiKey: "sk-openai-context-tag" });
    await combosDb.createCombo({
      name: "context-tag-combo",
      models: ["openai/gpt-4.1"],
    });

    const seenModels = [];
    globalThis.fetch = async (_url, init = {}) => {
      const body = JSON.parse(String(init.body));
      seenModels.push(body.model);
      return buildOpenAIResponse("Context tag response");
    };

    const response = await handleChat(
      buildRequest({
        body: {
          model: "context-tag-combo[500k]",
          stream: false,
          messages: [{ role: "user", content: "Use the context-tagged combo" }],
        },
      })
    );

    assert.equal(response.status, 200);
    assert.deepEqual(seenModels, ["gpt-4.1"]);
  });

  test("handleChat preserves a literal context-tagged combo name", async () => {
    await seedConnection("openai", { apiKey: "sk-openai-literal-context-tag" });
    await combosDb.createCombo({
      name: "literal [1m]",
      models: ["openai/gpt-4.1"],
    });

    const seenModels = [];
    globalThis.fetch = async (_url, init = {}) => {
      seenModels.push(JSON.parse(String(init.body)).model);
      return buildOpenAIResponse("Literal combo response");
    };

    const response = await handleChat(
      buildRequest({
        body: {
          model: "literal [1m]",
          stream: false,
          messages: [{ role: "user", content: "Use the literal combo" }],
        },
      })
    );

    assert.equal(response.status, 200);
    assert.deepEqual(seenModels, ["gpt-4.1"]);
  });

  test("Test 3: handleChat returns cached response directly for Semantic Cache hits", async () => {
    await seedConnection("openai", { apiKey: "sk-openai-semantic" });
    let fetchCount = 0;

    globalThis.fetch = async (_url, init) => {
      fetchCount++;
      const bodyStr = String(init.body);
      const body = JSON.parse(bodyStr);
      assert.equal(body.temperature, 0);

      return new Response(
        JSON.stringify({
          id: `chatcmpl_${fetchCount}`,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: `Cache Generation ${fetchCount}` },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const req1 = buildRequest({
      body: {
        model: "openai/gpt-4",
        stream: false,
        temperature: 0,
        messages: [{ role: "user", content: "semantic hit" }],
      },
    });

    const res1 = await handleChat(req1);
    await res1.json();
    assert.equal(fetchCount, 1);
    await new Promise((r) => setTimeout(r, 100)); // allow background cache write

    const req2 = buildRequest({
      body: {
        model: "openai/gpt-4",
        stream: false,
        temperature: 0,
        messages: [{ role: "user", content: "semantic hit" }],
      },
    });

    const res2 = await handleChat(req2);
    const json2 = (await res2.json()) as any;

    assert.equal(fetchCount, 1, "Should have hit the semantic cache without calling fetch again");
    assert.equal(json2.choices[0].message.content, "Cache Generation 1");
    assert.equal(res2.headers.get("X-OmniRoute-Cache"), "HIT");
  });

  test("Test 4: handleChat supports X-OmniRoute-Progress tracking header for streams", async () => {
    await seedConnection("openai", { apiKey: "sk-openai-progress" });

    globalThis.fetch = async () => {
      return new Response(
        [
          `data: {"id":"chatcmpl","choices":[{"delta":{"content":"P"},"index":0}]}`,
          `data: {"id":"chatcmpl","choices":[{"delta":{"content":"rogress"},"index":0}]}`,
          `data: [DONE]`,
          "",
        ].join("\n\n"),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }
      );
    };

    const response = await handleChat(
      buildRequest({
        headers: {
          "X-OmniRoute-Progress": "true",
        },
        body: {
          model: "openai/gpt-4",
          stream: true,
          messages: [{ role: "user", content: "progress check" }],
        },
      })
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-OmniRoute-Progress"), "enabled");

    const raw = await response.text();
    assert.match(raw, /event: progress/); // check that progress chunks were injected
    assert.match(raw, /content":"P"/);
  });

  test("Test 5: isTokenExpiringSoon detects token boundaries", async () => {
    const { isTokenExpiringSoon } = await import("../../../open-sse/handlers/chatCore.ts");
    const now = Date.now();

    assert.equal(isTokenExpiringSoon(null), false);
    assert.equal(
      isTokenExpiringSoon(new Date(now + 10 * 60 * 1000).toISOString(), 5 * 60 * 1000),
      false
    );
    assert.equal(
      isTokenExpiringSoon(new Date(now + 2 * 60 * 1000).toISOString(), 5 * 60 * 1000),
      true
    );
    assert.equal(
      isTokenExpiringSoon(new Date(now - 1 * 60 * 1000).toISOString(), 5 * 60 * 1000),
      true
    );
  });

  test("handleChat returns cached response directly for Idempotency hits", async () => {
    await seedConnection("openai", { apiKey: "sk-openai-idem" });

    globalThis.fetch = async () => buildOpenAIResponse("Original response");

    const reqBody = {
      model: "openai/gpt-4",
      stream: false,
      messages: [{ role: "user", content: "Idempotent req" }],
    };

    // First request: hits API and saves idempotency
    const response1 = await handleChat(
      buildRequest({
        headers: { "idempotency-key": "req-idempotent-123" },
        body: reqBody,
      })
    );
    await response1.json(); // Consume body

    const response2 = await handleChat(
      buildRequest({
        headers: { "idempotency-key": "req-idempotent-123" },
        body: reqBody,
      })
    );

    const json2 = (await response2.json()) as any;
    assert.equal(response2.status, 200);
    assert.equal(response2.headers.get("X-OmniRoute-Idempotent"), "true");
    assert.equal(json2.choices[0].message.content, "Original response");
  });

  test("Test 6: handleChat correctly sets isResponsesEndpoint for /v1/responses", async () => {
    await seedConnection("openai", { apiKey: "sk-openai-responses" });

    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-responses",
          object: "chat.completion",
          choices: [
            { message: { role: "assistant", content: "Responses OK" }, finish_reason: "stop" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const response = await handleChat(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/gpt-4",
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        }),
      })
    );

    const json = (await response.json()) as any;
    assert.equal(response.status, 200);
    const responseText = json.output_text || json.output?.[0]?.content?.[0]?.text;
    assert.equal(responseText, "Responses OK");
  });

  test("handleChat returns Semantic Cache hit", async () => {
    await seedConnection("openai", { apiKey: "sk-openai-semantic" });
    globalThis.fetch = async () => buildOpenAIResponse("Semantic API response");

    const model = "openai/gpt-4";
    const messages = [{ role: "user", content: "Semantic query test" }];
    const reqBody = {
      model,
      stream: false,
      temperature: 0, // required for cacheable
      messages,
    };

    // First request: hits API and saves semantic cache
    const response1 = await handleChat(buildRequest({ body: reqBody }));
    await response1.json(); // Consume body

    // Second request: should hit semantic cache
    const response2 = await handleChat(buildRequest({ body: reqBody }));

    const json2 = (await response2.json()) as any;
    assert.equal(response2.status, 200);
    assert.equal(response2.headers.get("X-OmniRoute-Cache"), "HIT");
    assert.equal(json2.choices[0].message.content, "Semantic API response");
  });
});
