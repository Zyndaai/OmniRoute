import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// conversationTurnContent.ts resolves a conversation_turn_nodes row's actual
// display text/tool-call shape on demand from the call-log artifact its
// last_correlation_id points at (migration 156 dropped the old stored
// text_preview/block_kind/tool_name columns -- see conversationTracker.ts).

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-conv-turn-content-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { getTestBackend, resetTestDb } = await import("../helpers/postgres.ts");
const { hashTurnContent } = await import("../../open-sse/services/conversationTracker.ts");
const { resolveTurnDisplayContent } =
  await import("../../open-sse/services/conversationTurnContent.ts");

before(async () => {
  await core.ensureDbInitialized();
});

beforeEach(async () => {
  await resetTestDb();
});

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function insertCallLog(row: {
  id: string;
  correlationId: string;
  artifactRelPath: string | null;
}) {
  // The resolver only reads artifacts whose detail is published ('ready').
  await getTestBackend().execute(
    `INSERT INTO call_logs (id, "timestamp", method, path, status, model, correlation_id, artifact_relpath, detail_state)
     VALUES ($1, $2, 'POST', '/v1/chat/completions', 200, 'big-pickle', $3, $4, $5)`,
    [
      row.id,
      new Date().toISOString(),
      row.correlationId,
      row.artifactRelPath,
      row.artifactRelPath ? "ready" : "none",
    ]
  );
}

function writeArtifact(relPath: string, clientRawRequestBody: unknown) {
  const absPath = path.join(TEST_DATA_DIR, "call_logs", relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(
    absPath,
    JSON.stringify({
      schemaVersion: 5,
      requestBody: null,
      responseBody: null,
      error: null,
      pipeline: {
        clientRawRequest: { body: clientRawRequestBody },
      },
    })
  );
}

test("resolveTurnDisplayContent resolves plain text turns from the artifact's raw request body", async () => {
  await insertCallLog({
    id: "log-1",
    correlationId: "corr-1",
    artifactRelPath: "2026-01-01/log-1.json",
  });
  writeArtifact("2026-01-01/log-1.json", {
    messages: [
      { role: "user", content: "hello there" },
      { role: "assistant", content: "hi!" },
    ],
  });

  const result = await resolveTurnDisplayContent([{ lastCorrelationId: "corr-1" }]);
  const userHash = hashTurnContent({
    role: "user",
    text: "hello there",
    blockKind: "text",
    toolName: null,
  });
  assert.deepEqual(result.get(userHash), {
    textPreview: "hello there",
    blockKind: "text",
    toolName: null,
  });
});

test("resolveTurnDisplayContent resolves tool_use/tool_result shape, full and untruncated", async () => {
  const bigArgs = JSON.stringify({ path: "/tmp/big.md", content: "line\n".repeat(2000) });
  await insertCallLog({
    id: "log-2",
    correlationId: "corr-2",
    artifactRelPath: "2026-01-01/log-2.json",
  });
  writeArtifact("2026-01-01/log-2.json", {
    input: [{ type: "function_call", name: "write", call_id: "c1", arguments: bigArgs }],
  });

  const result = await resolveTurnDisplayContent([{ lastCorrelationId: "corr-2" }]);
  const hash = hashTurnContent({
    role: "tool",
    text: bigArgs,
    blockKind: "tool_use",
    toolName: "write",
  });
  const content = result.get(hash);
  assert.equal(content?.blockKind, "tool_use");
  assert.equal(content?.toolName, "write");
  // No 8000-char truncation anymore -- the full raw arguments string survives.
  assert.equal(content?.textPreview, bigArgs);
  assert.ok(content!.textPreview.length > 8000);
});

test("resolveTurnDisplayContent groups nodes by correlation id, reading each artifact once", async () => {
  await insertCallLog({
    id: "log-3",
    correlationId: "corr-3",
    artifactRelPath: "2026-01-01/log-3.json",
  });
  writeArtifact("2026-01-01/log-3.json", {
    messages: [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ],
  });

  const result = await resolveTurnDisplayContent([
    { lastCorrelationId: "corr-3" },
    { lastCorrelationId: "corr-3" },
    { lastCorrelationId: "corr-3" },
  ]);

  for (const [role, text] of [
    ["user", "a"],
    ["assistant", "b"],
    ["user", "c"],
  ] as const) {
    const hash = hashTurnContent({ role, text, blockKind: "text", toolName: null });
    assert.equal(result.get(hash)?.textPreview, text);
  }
});

test("resolveTurnDisplayContent skips nodes with no correlation id without throwing", async () => {
  const result = await resolveTurnDisplayContent([{ lastCorrelationId: null }]);
  assert.equal(result.size, 0);
});

test("resolveTurnDisplayContent omits content for an unresolvable correlation id (missing call_logs row, purged artifact, or no pipeline captured)", async () => {
  const missingRow = await resolveTurnDisplayContent([
    { lastCorrelationId: "corr-does-not-exist" },
  ]);
  assert.equal(missingRow.size, 0);

  await insertCallLog({ id: "log-4", correlationId: "corr-4", artifactRelPath: null });
  const noArtifact = await resolveTurnDisplayContent([{ lastCorrelationId: "corr-4" }]);
  assert.equal(noArtifact.size, 0);

  await insertCallLog({
    id: "log-5",
    correlationId: "corr-5",
    artifactRelPath: "2026-01-01/does-not-exist.json",
  });
  const missingFile = await resolveTurnDisplayContent([{ lastCorrelationId: "corr-5" }]);
  assert.equal(missingFile.size, 0);
});
