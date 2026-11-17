import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "omniroute-call-log-provider-display-")
);
process.env.DATA_DIR = TEST_DATA_DIR;

import { getTestBackend, resetTestDb } from "../helpers/postgres.ts";

const core = await import("../../src/lib/db/core.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");
const callLogsRoute = await import("../../src/app/api/usage/call-logs/route.ts");

async function seedProviderNode(id: string, name: string, prefix: string) {
  const now = new Date().toISOString();
  await getTestBackend().execute(
    `INSERT INTO provider_nodes (id, type, name, prefix, api_type, base_url, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, prefix = EXCLUDED.prefix`,
    [id, "openai-compatible", name, prefix, "chat", "https://example.com/v1", now, now]
  );
}

test.beforeEach(async () => {
  await resetTestDb();
});

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("getCallLogs and getCallLogById expose providerDisplay from provider node name", async () => {
  const providerId = "openai-compatible-chat-bc66d849-c440-4087-96f7-056bc000b2b9";
  await seedProviderNode(providerId, "Bynara", "bynara");

  const now = new Date().toISOString();
  await getTestBackend().execute(
    `INSERT INTO call_logs (id, "timestamp", method, path, status, model, requested_model, provider, account, connection_id, duration, tokens_in, tokens_out)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      "log-provider-display-1",
      now,
      "POST",
      "/v1/chat/completions",
      200,
      "gpt-4.1",
      `${providerId}/gpt-4.1`,
      providerId,
      "acc1",
      null,
      123,
      10,
      20,
    ]
  );

  const rows = await callLogs.getCallLogs({ limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, providerId);
  assert.equal(rows[0].providerDisplay, "Bynara");
  assert.equal(rows[0].requestedModel, "bynara/gpt-4.1");

  const detail = await callLogs.getCallLogById("log-provider-display-1");
  assert.ok(detail);
  assert.equal(detail?.providerDisplay, "Bynara");
  assert.equal(detail?.requestedModel, "bynara/gpt-4.1");
});

test("buildCallLogListRows adds providerDisplay to active and completed in-memory rows", () => {
  const providerId = "openai-compatible-chat-bc66d849-c440-4087-96f7-056bc000b2b9";
  const rows = callLogsRoute.buildCallLogListRows({
    logs: [],
    connections: [],
    providerDisplayNames: new Map([[providerId, "Bynara"]]),
    pendingDetails: [
      {
        id: "pending-1",
        startedAt: Date.now() - 1000,
        clientEndpoint: "/v1/chat/completions",
        model: "gpt-4.1",
        provider: providerId,
        connectionId: null,
        correlationId: "cid-pending",
      },
    ],
    completedDetails: [
      {
        id: "completed-1",
        startedAt: Date.now() - 2000,
        completedAt: Date.now() - 500,
        durationMs: 1500,
        clientEndpoint: "/v1/chat/completions",
        model: "gpt-4.1",
        provider: providerId,
        connectionId: null,
        correlationId: "cid-completed",
        status: 200,
        error: null,
      },
    ],
  });

  const pending = rows.find((row) => row.id === "pending-1");
  const completed = rows.find((row) => row.id === "completed-1");

  assert.equal(pending?.providerDisplay, "Bynara");
  assert.equal(completed?.providerDisplay, "Bynara");
});
