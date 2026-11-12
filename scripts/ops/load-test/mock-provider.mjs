#!/usr/bin/env node
/**
 * OpenAI-compatible mock provider for load-testing OmniRoute without spending
 * inference: GET /v1/models and POST /v1/chat/completions (streaming or not),
 * with a fixed first-token delay and chunk cadence so every answer takes the same
 * time. No dependencies; run it next to OmniRoute so no tunnel sits in the path:
 *
 *   docker run -d --name mock-provider --network omniroute_default \
 *     -v /opt/omni-loadtest/mock-provider.mjs:/app/mock.mjs:ro \
 *     -v /opt/omni-loadtest/mock-key:/run/secrets/mock-key:ro \
 *     -e MOCK_API_KEY_FILE=/run/secrets/mock-key \
 *     node:26-alpine node /app/mock.mjs
 *
 * The provider connection then points at http://mock-provider:8080/v1. Other
 * placements and their trade-offs: docs/ops/LOAD_TESTING.md, "Where the mock runs".
 *
 * Env: MOCK_API_KEY_FILE (required), MOCK_PORT (8080), MOCK_FIRST_TOKEN_MS (300),
 * MOCK_CHUNKS (20), MOCK_CHUNK_INTERVAL_MS (100). The defaults give about 2.3 s
 * per streamed answer, close to a short real completion.
 *
 * GET /metrics serves the mock's own counters, so a run can show whether a
 * request reached the mock and when it finished, independently of OmniRoute.
 */

import { readFileSync } from "node:fs";
import http from "node:http";

const port = Number(process.env.MOCK_PORT || 8080);
const firstTokenMs = Number(process.env.MOCK_FIRST_TOKEN_MS || 300);
const chunks = Number(process.env.MOCK_CHUNKS || 20);
const chunkIntervalMs = Number(process.env.MOCK_CHUNK_INTERVAL_MS || 100);
const keyFile = process.env.MOCK_API_KEY_FILE;
if (!keyFile) throw new Error("MOCK_API_KEY_FILE is required");
const apiKey = readFileSync(keyFile, "utf8").trim();
if (!apiKey) throw new Error(`${keyFile} is empty`);

const counters = { received: 0, completed: 0, aborted: 0, unauthorized: 0, active: 0 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readBody(request) {
  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (part) => (raw += part));
    request.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function chunk(id, delta, finish = null) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "mock-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

const usage = { prompt_tokens: 10, completion_tokens: chunks, total_tokens: 10 + chunks };

async function completion(request, response) {
  const body = await readBody(request);
  const id = `mock-${counters.received}`;
  let closed = false;
  response.on("close", () => {
    if (!response.writableEnded) closed = true;
  });

  await sleep(firstTokenMs);
  if (body.stream) {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.write(chunk(id, { role: "assistant", content: "" }));
    for (let i = 0; i < chunks && !closed; i++) {
      response.write(chunk(id, { content: `tok${i} ` }));
      await sleep(chunkIntervalMs);
    }
    if (closed) return false;
    response.write(chunk(id, {}, "stop"));
    if (body.stream_options?.include_usage) {
      response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [], usage })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
    return true;
  }
  await sleep(chunks * chunkIntervalMs);
  if (closed) return false;
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "mock-model",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage,
    })
  );
  return true;
}

http
  .createServer(async (request, response) => {
    const path = (request.url || "").split("?")[0];
    if (request.method === "GET" && path === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
      return;
    }
    if (request.method === "GET" && path === "/metrics") {
      const lines = Object.entries(counters).map(([name, value]) => `mock_${name} ${value}`);
      response.writeHead(200, { "content-type": "text/plain" }).end(`${lines.join("\n")}\n`);
      return;
    }
    if (request.headers.authorization !== `Bearer ${apiKey}`) {
      counters.unauthorized++;
      response.writeHead(401, { "content-type": "application/json" }).end('{"error":{"message":"invalid key"}}');
      return;
    }
    if (request.method === "GET" && path === "/v1/models") {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end('{"object":"list","data":[{"id":"mock-model","object":"model","owned_by":"mock"}]}');
      return;
    }
    if (request.method === "POST" && path === "/v1/chat/completions") {
      counters.received++;
      counters.active++;
      try {
        if (await completion(request, response)) counters.completed++;
        else counters.aborted++;
      } finally {
        counters.active--;
      }
      return;
    }
    response.writeHead(404).end();
  })
  .listen(port, () => console.log(`[mock-provider] :${port} first token ${firstTokenMs} ms, ${chunks} chunks every ${chunkIntervalMs} ms`));
