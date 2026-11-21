/**
 * Integration tests — Qdrant embedding-models route:
 *   GET     /api/settings/qdrant/embedding-models
 *
 * The rest of the Qdrant settings surface (settings GET/PUT, health, search, cleanup)
 * belonged to the removed memory engine and is not covered here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  makeManagementSessionRequest,
  createManagementSessionHeaders,
} from "../helpers/managementSession.ts";
import { resetTestDb } from "../helpers/postgres.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-qdrant-routes-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-secret-qdrant-routes";

const { updateSettings } = await import("@/lib/db/settings");
const { createProviderConnection } = await import("@/lib/db/providers");
const localDb = { updateSettings, createProviderConnection };

// ── Route imports ──
const qdrantEmbeddingModelsRoute =
  await import("../../src/app/api/settings/qdrant/embedding-models/route.ts");

// ── Helpers ──

// Mirrors EmbeddingModelOption from the embedding-models route response shape.
interface EmbeddingModelOptionLike {
  value: string;
  label: string;
  dimensions?: number;
}

async function makeAuthRequest(method: "GET" | "POST" | "PUT", url: string, body?: unknown) {
  return makeManagementSessionRequest(url, { method, body });
}

function makeUnauthRequest(method: "GET" | "POST" | "PUT", url: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function setRequireLogin(enabled: boolean) {
  if (enabled) {
    await localDb.updateSettings({ requireLogin: true, password: "hashed-pw" });
  } else {
    await localDb.updateSettings({ requireLogin: false });
  }
}

// ── Test lifecycle ──

test.beforeEach(async () => {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await localDb.updateSettings({ requireLogin: false });
});

test.after(async () => {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── Embedding models ──

test("GET /api/settings/qdrant/embedding-models — returns models array", async () => {
  const headers = await createManagementSessionHeaders();
  const req = new Request("http://localhost/api/settings/qdrant/embedding-models", {
    method: "GET",
    headers: Object.fromEntries(headers.entries()),
  });

  const res = await qdrantEmbeddingModelsRoute.GET(req);
  // 200 expected; verify shape
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.models), "should have models array");
  assert.strictEqual(body.models.length, 0, "should not list models without a configured provider");
});

test("GET /api/settings/qdrant/embedding-models — lists only configured providers", async () => {
  await localDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "embedding-test-openai",
    apiKey: "sk-test-embedding",
  });

  const headers = await createManagementSessionHeaders();
  const req = new Request("http://localhost/api/settings/qdrant/embedding-models", {
    method: "GET",
    headers: Object.fromEntries(headers.entries()),
  });

  const res = await qdrantEmbeddingModelsRoute.GET(req);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(body.models.length > 0, "should list models for configured provider");
  assert.ok(body.models.every((model: any) => model.value.startsWith("openai/")));
  assert.ok(body.models.some((model: any) => model.value === "openai/text-embedding-3-small"));
  const defaultModel = body.models.find((m: any) => m.value === "openai/text-embedding-3-small");
  assert.match(defaultModel.label, /1536d/);
});

test("GET /api/settings/qdrant/embedding-models — includes an active local no-API-key provider (#11949)", async () => {
  // Local providers (e.g. ollama-local) are created through the connections
  // route with authType "apikey" but no apiKey — the connect form never asks
  // for one (src/shared/constants/providers/local.ts). An active connection
  // like this must still surface its embedding models.
  await localDb.createProviderConnection({
    provider: "ollama-local",
    authType: "apikey",
    name: "local-ollama",
  });

  const headers = await createManagementSessionHeaders();
  const req = new Request("http://localhost/api/settings/qdrant/embedding-models", {
    method: "GET",
    headers: Object.fromEntries(headers.entries()),
  });

  const res = await qdrantEmbeddingModelsRoute.GET(req);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(
    body.models.some(
      (model: EmbeddingModelOptionLike) => model.value === "ollama-local/embeddinggemma"
    ),
    "should list ollama-local embedding models for an active, key-less local connection"
  );
});

test("GET /api/settings/qdrant/embedding-models — keeps curated models for configured providers only", async () => {
  await localDb.createProviderConnection({
    provider: "cohere",
    authType: "apikey",
    name: "configured-curated",
    apiKey: "sk-test-cohere-embedding",
    isActive: true,
  });
  await localDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "inactive-with-key",
    apiKey: "sk-test-inactive-embedding",
    isActive: false,
  });
  const req = await makeAuthRequest("GET", "http://localhost/api/settings/qdrant/embedding-models");
  const res = await qdrantEmbeddingModelsRoute.GET(req);
  assert.equal(res.status, 200);
  const { models } = (await res.json()) as { models: EmbeddingModelOptionLike[] };
  assert.ok(
    models.some((model) => model.value === "cohere/embed-v4.0"),
    "retain the curated-catalog feature from #11390"
  );
  assert.ok(
    models.every((model) => model.value.startsWith("cohere/")),
    "unconfigured or inactive providers must not be offered"
  );
  assert.equal(
    new Set(models.map((model) => model.value)).size,
    models.length,
    "merged catalog stays deduplicated"
  );
});

test("GET /api/settings/qdrant/embedding-models — still excludes a remote provider with no key", async () => {
  // A remote provider that DOES require a key must stay excluded when the
  // connection was created/left without one — regression guard for the fix
  // above so it does not become "drop the filter entirely".
  await localDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "embedding-test-openai-no-key",
  });

  const headers = await createManagementSessionHeaders();
  const req = new Request("http://localhost/api/settings/qdrant/embedding-models", {
    method: "GET",
    headers: Object.fromEntries(headers.entries()),
  });

  const res = await qdrantEmbeddingModelsRoute.GET(req);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(
    body.models.every((model: EmbeddingModelOptionLike) => !model.value.startsWith("openai/")),
    "should not list a remote provider's models when its active connection has no API key"
  );
});

test("GET /api/settings/qdrant/embedding-models — 401 without auth", async () => {
  await setRequireLogin(true);
  const req = makeUnauthRequest("GET", "http://localhost/api/settings/qdrant/embedding-models");
  const res = await qdrantEmbeddingModelsRoute.GET(req);
  assert.strictEqual(res.status, 401);
  await setRequireLogin(false);
});
