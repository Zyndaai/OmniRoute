// Executors that run their own fetch flow (they never call BaseExecutor.execute) must send the
// upstream call through the provider dispatch guard, which follows redirects by hand and checks
// every hop. A bare fetch() auto-follows a redirect to a target nobody validated (#19974).
// No network: globalThis.fetch is stubbed and answers 302 -> cloud-metadata address.
import test from "node:test";
import assert from "node:assert/strict";

import { NlpCloudExecutor } from "../../open-sse/executors/nlpcloud.ts";
import { OneMinAiExecutor } from "../../open-sse/executors/oneminai.ts";
import { DarioExecutor } from "../../open-sse/executors/dario.ts";
import { GlmExecutor } from "../../open-sse/executors/glm.ts";
import { GheCopilotExecutor } from "../../open-sse/executors/ghe-copilot.ts";

const METADATA = "http://169.254.169.254/latest/meta-data/";

type Call = { url: string; redirect: RequestRedirect | undefined };

async function withRedirectingFetch<T>(run: (calls: Call[]) => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), redirect: init?.redirect });
    return new Response(null, { status: 302, headers: { location: METADATA } });
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = real;
  }
}

function assertGuarded(calls: Call[], label: string) {
  assert.ok(calls.length >= 1, `${label}: the upstream was called`);
  assert.equal(calls[0].redirect, "manual", `${label}: redirects are followed by hand`);
  assert.ok(
    !calls.some((c) => c.url === METADATA),
    `${label}: a redirect to the metadata address is never fetched`
  );
}

const chatInput = {
  stream: false,
  signal: AbortSignal.timeout(10_000),
  log: null,
  body: { messages: [{ role: "user", content: "hi" }] },
};

test("NlpCloudExecutor dispatch goes through the guard", async () => {
  await withRedirectingFetch(async (calls) => {
    await new NlpCloudExecutor()
      .execute({ ...chatInput, model: "chatdolphin", credentials: { apiKey: "k" } })
      .catch(() => null);
    assertGuarded(calls, "nlpcloud");
  });
});

test("OneMinAiExecutor dispatch goes through the guard", async () => {
  await withRedirectingFetch(async (calls) => {
    await new OneMinAiExecutor()
      .execute({ ...chatInput, model: "gpt-4o-mini", credentials: { apiKey: "k" } })
      .catch(() => null);
    assertGuarded(calls, "oneminai");
  });
});

test("DarioExecutor dispatch goes through the guard", async () => {
  await withRedirectingFetch(async (calls) => {
    await new DarioExecutor("http://127.0.0.1:3456")
      .execute({ ...chatInput, model: "claude-sonnet-4-5", credentials: { apiKey: "k" } })
      .catch(() => null);
    assertGuarded(calls, "dario");
  });
});

test("GlmExecutor dispatch goes through the guard", async () => {
  await withRedirectingFetch(async (calls) => {
    await new GlmExecutor("glm")
      .execute({ ...chatInput, model: "glm-4.6", credentials: { apiKey: "k" } })
      .catch(() => null);
    assertGuarded(calls, "glm");
  });
});

test("GheCopilotExecutor token mint goes through the guard", async () => {
  await withRedirectingFetch(async (calls) => {
    const token = await new GheCopilotExecutor().refreshCopilotToken("gho_x", undefined, {
      providerSpecificData: { gheUrl: "https://ghe.example.com" },
    });
    assert.equal(token, null);
    assertGuarded(calls, "ghe-copilot");
  });
});
