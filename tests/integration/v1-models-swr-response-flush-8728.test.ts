import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const CACHE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-swr-cache-8728-"));
process.env.DATA_DIR = CACHE_DATA_DIR;

const catalogCache = await import("../../src/app/api/v1/models/catalogCache.ts");
const { compressResponses } = await import("../../src/server/http/compression.ts");
const { createAppHandler } = await import("../../src/server/http/handler.ts");
const { createNodeListener } = await import("../../src/server/http/nodeListener.ts");
const BLOCK_MS = 300;

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Fetches from a separate process: the server's event loop is blocked by the rebuild, so only
 * another process can tell when the bytes actually arrived.
 */
function fetchFromExternalClient(
  port: number
): Promise<{ body: string; encoding: string; receivedAt: number }> {
  const script = [
    'import http from "node:http";',
    'import zlib from "node:zlib";',
    "const chunks = [];",
    "const request = http.request({ host: '127.0.0.1', port: Number(process.argv[1]), path: '/catalog-swr', headers: { 'accept-encoding': 'gzip' } }, (response) => {",
    "  response.on('data', (chunk) => chunks.push(chunk));",
    "  response.on('end', () => {",
    "    const receivedAt = Date.now();",
    "    const encoding = response.headers['content-encoding'] || '';",
    "    const raw = Buffer.concat(chunks);",
    "    const body = (encoding === 'gzip' ? zlib.gunzipSync(raw) : raw).toString('utf8');",
    "    process.stdout.write(JSON.stringify({ body, encoding, receivedAt }));",
    "  });",
    "});",
    "request.on('error', (error) => { throw error; });",
    "request.end();",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`external fetch exited ${code}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
}

function productionShapedSynchronousRefresh() {
  const models = Array.from({ length: 4_000 }, (_, index) => ({
    id: `provider/model-${index}`,
    object: "model",
    owned_by: "provider",
    display_name: `Model ${index}`,
  }));
  const startedAt = Date.now();
  do {
    JSON.stringify({ object: "list", data: models });
  } while (Date.now() - startedAt < BLOCK_MS);
}

/** Large enough to be gzip-compressed, so the compressor's asynchronous tail is exercised. */
function catalogBody(label: string): string {
  const data = Array.from({ length: 2_000 }, (_, index) => ({ id: `${label}/model-${index}` }));
  return JSON.stringify({ label, data });
}

test.after(() => {
  fs.rmSync(CACHE_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("outside a request the default scheduler defers the rebuild to a later macrotask and logs a failed rebuild", async () => {
  const order: string[] = [];
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    catalogCache.defaultBackgroundRefreshScheduler(async () => {
      order.push("task");
      throw new Error("rebuild failed");
    });
    order.push("scheduled");
    assert.deepEqual(order, ["scheduled"], "the task must not run synchronously");
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(order, ["scheduled", "task"]);
  assert.equal(errors.length, 1, "a failed rebuild is logged, not left unhandled");
});

test("a gzip client receives the whole stale body before the synchronous rebuild finishes", async () => {
  catalogCache.__resetCatalogBuilderRunsForTest();

  let buildCount = 0;
  let refreshStartedAt = 0;
  let refreshFinishedAt = 0;
  const responseClosedAt: number[] = [];

  const render = (request: Request) =>
    catalogCache.resolveCachedCatalogResponse(
      request,
      { corsHeaders: {}, diagnosticHeaders: {} },
      async () => {
        buildCount++;
        if (buildCount > 1) {
          refreshStartedAt = Date.now();
          productionShapedSynchronousRefresh();
          refreshFinishedAt = Date.now();
        }
        return {
          body: catalogBody(buildCount > 1 ? "new" : "old"),
          headers: { "content-type": "application/json" },
          status: 200,
          cacheTTL: 60_000,
        };
      },
      // Production scheduler (afterResponse); only the stale window is widened so the entry
      // stays in the stale branch however slow the machine is.
      { getStaleWhileRevalidateMs: () => Number.POSITIVE_INFINITY }
    );

  const listener = createNodeListener(createAppHandler({ basePath: () => "", render }));
  const server = http.createServer((req, res) => {
    res.once("close", () => responseClosedAt.push(Date.now()));
    compressResponses(req, res, () => listener(req, res));
  });

  const port = await listen(server);
  try {
    const first = await fetchFromExternalClient(port);
    assert.equal(JSON.parse(first.body).label, "old");
    catalogCache.__expireCatalogCacheForTest();

    const stale = await fetchFromExternalClient(port);
    await catalogCache.__flushCatalogBackgroundRefreshForTest();

    assert.equal(stale.encoding, "gzip", "the stale body must go through the compressor");
    assert.equal(JSON.parse(stale.body).label, "old");
    assert.equal(buildCount, 2, "exactly one background rebuild");
    assert.ok(
      refreshStartedAt >= responseClosedAt[1],
      "the rebuild must start after the stale response has closed"
    );
    assert.ok(
      stale.receivedAt < refreshFinishedAt,
      `external client received stale body at ${stale.receivedAt}, after refresh finished at ${refreshFinishedAt}`
    );
    assert.ok(
      refreshFinishedAt - refreshStartedAt >= BLOCK_MS,
      "refresh did not exercise the synchronous blocking window"
    );
  } finally {
    await close(server);
    catalogCache.__resetCatalogBuilderRunsForTest();
  }
});
