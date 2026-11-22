/**
 * Pure claude -> claude passthrough: prompt-cache rescue, billing-line hygiene and
 * copy-on-write of `output_config` (ported from upstream v3.8.54).
 *
 * Marker-less Anthropic-format clients (Cursor and similar) ship zero `cache_control`
 * breakpoints through passthrough, so the full prefix is billed uncached every turn. The rescue
 * injects breakpoints ONLY when none exist anywhere; a client that manages its own markers must
 * stay byte-untouched.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildClaudePassthroughBody } from "../../open-sse/handlers/chatCore/claudePassthroughBody.ts";
import { ensurePassthroughCacheBreakpoints } from "../../open-sse/handlers/chatCore/passthroughCacheBreakpoints.ts";

type Block = Record<string, unknown>;

function markerlessBody(): Record<string, unknown> {
  return {
    model: "claude-sonnet-5",
    system: [
      { type: "text", text: "You are a helpful assistant." },
      { type: "text", text: "Project context goes here." },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "u1" }] },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      { role: "user", content: [{ type: "text", text: "u2" }] },
      { role: "assistant", content: [{ type: "text", text: "a2" }] },
      { role: "user", content: [{ type: "text", text: "u3" }] },
    ],
  };
}

function cacheControlledBlocks(body: Record<string, unknown>): Block[] {
  const blocks: Block[] = [];
  if (Array.isArray(body.system)) {
    for (const block of body.system) {
      if ((block as Block)?.cache_control) blocks.push(block as Block);
    }
  }
  if (Array.isArray(body.messages)) {
    for (const message of body.messages as Array<{ role: string; content: unknown }>) {
      if (Array.isArray(message.content)) {
        for (const block of message.content as Block[]) {
          if (block?.cache_control) blocks.push(block);
        }
      }
    }
  }
  return blocks;
}

describe("ensurePassthroughCacheBreakpoints", () => {
  test("injects markers into a marker-less body", () => {
    const result = ensurePassthroughCacheBreakpoints(markerlessBody());

    const system = result.system as Block[];
    assert.deepEqual(system[system.length - 1].cache_control, { type: "ephemeral", ttl: "1h" });
    assert.equal(system[0].cache_control, undefined);

    const messages = result.messages as Array<{ role: string; content: Block[] }>;
    const users = messages.filter((m) => m.role === "user").map((m) => m.content);
    assert.deepEqual(users[1][0].cache_control, { type: "ephemeral" });
    assert.equal(users[0][0].cache_control, undefined);
    assert.equal(users[2][0].cache_control, undefined);

    const assistants = messages.filter((m) => m.role === "assistant").map((m) => m.content);
    assert.deepEqual(assistants[1][0].cache_control, { type: "ephemeral" });
    assert.equal(assistants[0][0].cache_control, undefined);
  });

  test("no-op when the client already manages markers", () => {
    const body = markerlessBody();
    const clientMarker = { type: "ephemeral", ttl: "5m" };
    const system = body.system as Block[];
    system[system.length - 1].cache_control = clientMarker;

    const result = ensurePassthroughCacheBreakpoints(body);

    assert.deepEqual(
      (result.system as Block[])[(result.system as Block[]).length - 1].cache_control,
      clientMarker
    );
    assert.equal(cacheControlledBlocks(result).length, 1, "no extra markers may be injected");
  });

  test("a marker in any message content block counts as client-managed", () => {
    const body = markerlessBody();
    (body.messages as Array<{ content: Block[] }>)[0].content[0].cache_control = {
      type: "ephemeral",
    };
    const result = ensurePassthroughCacheBreakpoints(body);
    assert.equal(cacheControlledBlocks(result).length, 1);
  });

  test("a marker on a tool counts as client-managed", () => {
    const body = markerlessBody();
    body.tools = [{ name: "t", input_schema: {}, cache_control: { type: "ephemeral" } }];
    const result = ensurePassthroughCacheBreakpoints(body);
    assert.equal(cacheControlledBlocks(result).length, 0);
  });

  test("string content is normalized to blocks before marking", () => {
    const body = markerlessBody();
    (body.messages as Array<{ content: unknown }>)[0].content = "plain u1 text";
    const result = ensurePassthroughCacheBreakpoints(body);
    const messages = result.messages as Array<{ content: Block[] }>;
    assert.deepEqual(messages[0].content[0], { type: "text", text: "plain u1 text" });
  });

  test("empty conversation and missing system are safe no-ops", () => {
    assert.deepEqual(ensurePassthroughCacheBreakpoints({ messages: [] }), { messages: [] });

    const noSystem = ensurePassthroughCacheBreakpoints({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    const messages = noSystem.messages as Array<{ content: Block[] }>;
    assert.equal(messages[0].content[0].cache_control, undefined);
  });

  test("mutates in place and returns the same object reference", () => {
    const body = markerlessBody();
    assert.equal(ensurePassthroughCacheBreakpoints(body), body);
  });
});

describe("ensurePassthroughCacheBreakpoints block eligibility", () => {
  const signedThinking = { type: "thinking", thinking: "plan", signature: "sig" };
  const redactedThinking = { type: "redacted_thinking", data: "opaque" };

  function withLastAssistant(content: Block[]): Record<string, unknown> {
    const body = markerlessBody();
    (body.messages as Array<{ content: Block[] }>)[3].content = content;
    return body;
  }

  for (const trailing of [signedThinking, redactedThinking]) {
    test(`a trailing ${trailing.type} block stays unmarked`, () => {
      const body = withLastAssistant([{ type: "text", text: "a2" }, { ...trailing }]);
      ensurePassthroughCacheBreakpoints(body);
      const content = (body.messages as Array<{ content: Block[] }>)[3].content;
      assert.equal(content[1].cache_control, undefined);
      assert.deepEqual(content[0].cache_control, { type: "ephemeral" });
    });
  }

  test("a thinking-only last assistant turn falls back to the previous one", () => {
    const body = withLastAssistant([{ ...signedThinking }]);
    ensurePassthroughCacheBreakpoints(body);
    const messages = body.messages as Array<{ content: Block[] }>;
    assert.equal(messages[3].content[0].cache_control, undefined);
    assert.deepEqual(messages[1].content[0].cache_control, { type: "ephemeral" });
  });

  for (const text of ["", "  \n"]) {
    test(`a blank text block (${JSON.stringify(text)}) stays unmarked`, () => {
      const body = withLastAssistant([
        { type: "text", text: "a2" },
        { type: "text", text },
      ]);
      ensurePassthroughCacheBreakpoints(body);
      const content = (body.messages as Array<{ content: Block[] }>)[3].content;
      assert.equal(content[1].cache_control, undefined);
      assert.deepEqual(content[0].cache_control, { type: "ephemeral" });
    });
  }

  test("a blank system tail moves the 1h breakpoint to the last real block", () => {
    const body = markerlessBody();
    const system = body.system as Block[];
    system.push({ type: "text", text: "" });
    ensurePassthroughCacheBreakpoints(body);
    assert.equal(system[2].cache_control, undefined);
    assert.deepEqual(system[1].cache_control, { type: "ephemeral", ttl: "1h" });
  });
});

describe("buildClaudePassthroughBody cache breakpoint gate", () => {
  function build(
    body: Record<string, unknown>,
    provider: string,
    connectionCacheOverride?: Record<string, unknown> | null,
    effectiveModel = "claude-sonnet-5"
  ): Record<string, unknown> {
    return buildClaudePassthroughBody({
      body,
      provider,
      clientHeaders: null,
      isClaudeCodeSemanticPassthrough: false,
      effectiveModel,
      targetFormat: "claude",
      preserveCacheControl: false,
      connectionCacheOverride,
      normalizeClaudeUpstreamMessages: () => {},
      applyReasoningRuleDirective: (b: unknown) => b,
      log: null,
    } as never);
  }

  test("markers never reach the caller's body, which a combo replays on its next step", () => {
    const body = markerlessBody();
    (body.messages as Array<{ content: unknown }>)[0].content = "plain u1 text";
    const original = structuredClone(body);

    const out = build(body, "claude");

    assert.ok(cacheControlledBlocks(out).length > 0, "the dispatched body carries the markers");
    assert.deepEqual(body, original);
  });

  test("anthropic-compatible connections get the breakpoints", () => {
    const out = build(markerlessBody(), "anthropic-compatible-acme");
    assert.equal(cacheControlledBlocks(out).length, 3);
  });

  test("third-party Claude-shape providers get none", () => {
    assert.equal(cacheControlledBlocks(build(markerlessBody(), "kimi-coding")).length, 0);
  });

  for (const override of [{ supportsPromptCaching: false }, { cacheControlPassthrough: "strip" }]) {
    test(`a connection with ${JSON.stringify(override)} opts out`, () => {
      const out = build(markerlessBody(), "anthropic-compatible-acme", override);
      assert.equal(cacheControlledBlocks(out).length, 0);
    });
  }
});

describe("buildClaudePassthroughBody billing line", () => {
  const BILLING = "x-anthropic-billing-header: cc_version=2.1.0.abc; cch=00000;";

  function build(provider: string, model: string, body: Record<string, unknown>) {
    return buildClaudePassthroughBody({
      body,
      provider,
      clientHeaders: null,
      isClaudeCodeSemanticPassthrough: false,
      effectiveModel: model,
      targetFormat: "claude",
      preserveCacheControl: false,
      normalizeClaudeUpstreamMessages: () => {},
      applyReasoningRuleDirective: (b: unknown) => b,
      log: null,
    } as never);
  }

  function bodyWithBilling(): Record<string, unknown> {
    const body = markerlessBody();
    body.system = [
      { type: "text", text: BILLING },
      { type: "text", text: "You are Claude Code." },
    ];
    return body;
  }

  test("a non-Claude Anthropic-shape target does not receive the billing line", () => {
    const body = bodyWithBilling();
    const out = build("kimi-coding", "kimi-k3", body);
    const system = out.system as Block[];
    assert.equal(system.length, 1);
    assert.equal(system[0].text, "You are Claude Code.");
    assert.equal((body.system as Block[]).length, 2, "the caller's body is untouched");
  });

  test("a Claude target keeps the billing line", () => {
    const out = build("claude", "claude-sonnet-5", bodyWithBilling());
    assert.equal((out.system as Block[]).length, 2);
  });

  test("a string system loses only the billing line", () => {
    const body = markerlessBody();
    body.system = `${BILLING}\nYou are Claude Code.`;
    const out = build("kimi-coding", "kimi-k3", body);
    assert.equal(out.system, "You are Claude Code.");
  });
});

describe("buildClaudePassthroughBody output_config copy-on-write", () => {
  test("stripping format for a third-party target leaves the caller's output_config alone", () => {
    const body = markerlessBody();
    body.output_config = { effort: "high", format: { type: "json_schema", schema: {} } };
    const original = structuredClone(body);

    const out = buildClaudePassthroughBody({
      body,
      provider: "kimi-coding",
      clientHeaders: null,
      isClaudeCodeSemanticPassthrough: false,
      effectiveModel: "kimi-k3",
      targetFormat: "claude",
      preserveCacheControl: false,
      normalizeClaudeUpstreamMessages: () => {},
      applyReasoningRuleDirective: (b: unknown) => b,
      log: null,
    } as never);

    assert.deepEqual(out.output_config, { effort: "high" });
    assert.deepEqual(body, original);
  });
});
