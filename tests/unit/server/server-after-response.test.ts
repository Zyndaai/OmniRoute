import assert from "node:assert/strict";
import test from "node:test";

const { afterResponse, currentRequest } = await import("../../../src/server/requestContext.ts");
const { createAppHandler } = await import("../../../src/server/http/handler.ts");

const nextMacrotask = () => new Promise((resolve) => setImmediate(resolve));

function handlerWith(render: (request: Request) => Promise<Response>) {
  return createAppHandler({ basePath: () => "", render });
}

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

test("outside a request a callback runs on a later macrotask", async () => {
  const order: string[] = [];
  afterResponse(() => order.push("callback"));
  order.push("registered");
  assert.deepEqual(order, ["registered"]);
  await nextMacrotask();
  assert.deepEqual(order, ["registered", "callback"]);
});

test("a failing callback is logged and never thrown", async () => {
  const logged: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    afterResponse(() => {
      throw new Error("sync failure");
    });
    afterResponse(async () => {
      throw new Error("async failure");
    });
    await nextMacrotask();
    await nextMacrotask();
  } finally {
    console.error = originalError;
  }
  assert.equal(logged.length, 2);
});

test("callbacks run only after the body has been read to the end, exactly once", async () => {
  let runs = 0;
  const handle = handlerWith(async (request) => {
    assert.equal(currentRequest(), request);
    afterResponse(() => runs++);
    return new Response(streamOf("a", "b"), { headers: { "content-type": "text/plain" } });
  });

  const response = await handle(new Request("http://127.0.0.1/catalog"));
  assert.equal(response.headers.get("content-type"), "text/plain");
  const reader = response.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "a");
  await nextMacrotask();
  assert.equal(runs, 0, "not while the body is still being read");
  await reader.read();
  assert.equal((await reader.read()).done, true);
  await nextMacrotask();
  assert.equal(runs, 1);
  await nextMacrotask();
  assert.equal(runs, 1);
});

test("cancelling the body releases the callbacks", async () => {
  let runs = 0;
  const handle = handlerWith(async () => {
    afterResponse(() => runs++);
    return new Response(streamOf("a", "b"));
  });
  const response = await handle(new Request("http://127.0.0.1/catalog"));
  await response.body!.cancel();
  await nextMacrotask();
  assert.equal(runs, 1);
});

test("a response without a body releases the callbacks at once", async () => {
  let runs = 0;
  const handle = handlerWith(async () => {
    afterResponse(() => runs++);
    return new Response(null, { status: 204 });
  });
  await handle(new Request("http://127.0.0.1/catalog"));
  await nextMacrotask();
  assert.equal(runs, 1);
});

test("a client abort before the body is read releases the callbacks", async () => {
  let runs = 0;
  const controller = new AbortController();
  const handle = handlerWith(async () => {
    afterResponse(() => runs++);
    return new Response(streamOf("a"));
  });
  await handle(new Request("http://127.0.0.1/catalog", { signal: controller.signal }));
  controller.abort();
  await nextMacrotask();
  assert.equal(runs, 1);
});

test("a handler that throws still releases the callbacks", async () => {
  let runs = 0;
  const handle = handlerWith(async () => {
    afterResponse(() => runs++);
    throw new Error("render failed");
  });
  await assert.rejects(handle(new Request("http://127.0.0.1/catalog")), /render failed/);
  await nextMacrotask();
  assert.equal(runs, 1);
});

test("a response is passed through untouched when nothing was registered", async () => {
  const original = new Response(streamOf("a"));
  const handle = handlerWith(async () => original);
  assert.equal(await handle(new Request("http://127.0.0.1/catalog")), original);
});

test("a React Router data URL on an endpoint answers 404 without reaching the router", async () => {
  const served: string[] = [];
  const handle = handlerWith(async (request) => {
    served.push(new URL(request.url).pathname);
    return new Response("page");
  });

  for (const path of [
    "/api/v1/models.data",
    "/API/settings.data",
    "/api/providers/_.data",
    "/v1/models.data",
    "/models.data",
    "/v1beta/models/x.data",
  ]) {
    const response = await handle(new Request(`http://127.0.0.1${path}`));
    assert.equal(response.status, 404, path);
    const body = (await response.json()) as { error?: { message?: string } };
    assert.equal(typeof body.error?.message, "string", path);
  }
  assert.deepEqual(served, []);

  // Pages keep their data requests.
  assert.equal(await (await handle(new Request("http://127.0.0.1/login.data"))).text(), "page");
  assert.deepEqual(served, ["/login.data"]);
});
