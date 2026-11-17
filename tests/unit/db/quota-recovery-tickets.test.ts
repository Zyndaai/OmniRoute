import test from "node:test";
import assert from "node:assert/strict";
import { getTestBackend, resetTestDb } from "../../helpers/postgres.ts";

process.env.STORAGE_ENCRYPTION_KEY = "quota-recovery-test-key";

const tickets = await import("../../../src/lib/db/quotaRecoveryTickets.ts");

// The tests in this file share one database (each file has its own, see isolatePostgres.ts)
// and build on each other's tickets, so it is reset once, up front.
test.before(async () => {
  await resetTestDb();
});

test("deduplicates a pending turn and stores only encrypted payload", async () => {
  const input = {
    apiKeyId: "key-a",
    turnKey: "session-1/turn-1",
    endpoint: "responses" as const,
    requestPayload: JSON.stringify({ prompt: "private prompt" }),
    nextAttemptAt: "2026-09-28T09:00:00.000Z",
    expiresAt: "2026-09-29T09:00:00.000Z",
  };
  const first = await tickets.enqueueQuotaRecoveryTicket(input);
  const second = await tickets.enqueueQuotaRecoveryTicket(input);
  assert.equal(first.id, second.id);
  await assert.rejects(
    () => tickets.enqueueQuotaRecoveryTicket({ ...input, requestPayload: "different" }),
    /identity was reused/
  );
  assert.equal(await tickets.getQuotaRecoveryTicket(first.id, "key-b"), null);

  const raw = await getTestBackend().queryOne<{ request_ciphertext: string }>(
    "SELECT request_ciphertext FROM quota_recovery_tickets WHERE id = $1",
    [first.id]
  );
  assert.ok(raw);
  assert.match(raw.request_ciphertext, /^enc:v1:/);
  assert.doesNotMatch(raw.request_ciphertext, /private prompt/);
});

test("claims once, retains a failed attempt, and exposes a result only to its owner", async () => {
  const input = {
    apiKeyId: "key-a",
    turnKey: "session-1/turn-2",
    endpoint: "chat/completions" as const,
    requestPayload: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    nextAttemptAt: "2026-09-28T09:00:00.000Z",
    expiresAt: "2026-09-29T09:00:00.000Z",
  };
  const item = await tickets.enqueueQuotaRecoveryTicket(input);
  assert.equal(
    (await tickets.listDueQuotaRecoveryTickets(new Date("2026-09-28T08:59:59Z"))).length,
    0
  );
  assert.ok(
    (await tickets.listDueQuotaRecoveryTickets(new Date("2026-09-28T09:00:00Z"))).some(
      (due) => due.id === item.id
    )
  );
  assert.equal(
    (await tickets.claimQuotaRecoveryTicket(item.id, new Date("2026-09-28T09:00:00Z")))
      ?.attemptCount,
    1
  );
  assert.equal(
    await tickets.claimQuotaRecoveryTicket(item.id, new Date("2026-09-28T09:00:00Z")),
    null
  );
  assert.equal(await tickets.readQuotaRecoveryRequest(item.id), input.requestPayload);
  assert.equal(
    await tickets.rescheduleQuotaRecoveryTicket(item.id, "2026-09-28T09:01:00.000Z"),
    true
  );
  assert.equal(
    (await tickets.claimQuotaRecoveryTicket(item.id, new Date("2026-09-28T09:01:00Z")))
      ?.attemptCount,
    2
  );
  assert.equal(
    await tickets.completeQuotaRecoveryTicket(item.id, '{"answer":"done"}'),
    true
  );
  assert.equal(await tickets.readQuotaRecoveryResult(item.id, "key-b"), null);
  assert.equal(await tickets.readQuotaRecoveryResult(item.id, "key-a"), '{"answer":"done"}');
  assert.equal(await tickets.readQuotaRecoveryRequest(item.id), null);
});

test("interrupted dispatch requires confirmation instead of replay", async () => {
  const item = await tickets.enqueueQuotaRecoveryTicket({
    apiKeyId: "key-a",
    turnKey: "session-1/turn-3",
    endpoint: "responses",
    requestPayload: "{}",
    nextAttemptAt: "2026-09-28T09:00:00.000Z",
    expiresAt: "2026-09-29T09:00:00.000Z",
  });
  assert.ok(await tickets.claimQuotaRecoveryTicket(item.id, new Date("2026-09-28T09:00:00Z")));
  assert.equal(await tickets.reconcileInterruptedQuotaRecoveries(), 1);
  assert.equal(
    (await tickets.getQuotaRecoveryTicket(item.id, "key-a"))?.state,
    "needs_confirmation"
  );
  assert.equal(
    await tickets.claimQuotaRecoveryTicket(item.id, new Date("2026-09-28T09:02:00Z")),
    null
  );
  assert.equal(await tickets.cancelQuotaRecoveryTicket(item.id, "key-a"), true);
  assert.equal((await tickets.getQuotaRecoveryTicket(item.id, "key-a"))?.state, "cancelled");
});

test("pending owner may cancel; expired payloads are erased", async () => {
  const item = await tickets.enqueueQuotaRecoveryTicket({
    apiKeyId: "key-a",
    turnKey: "session-1/turn-4",
    endpoint: "responses",
    requestPayload: "{}",
    nextAttemptAt: "2026-09-28T09:00:00.000Z",
    expiresAt: "2026-09-28T10:00:00.000Z",
  });
  assert.equal(await tickets.cancelQuotaRecoveryTicket(item.id, "key-b"), false);
  assert.equal(await tickets.cancelQuotaRecoveryTicket(item.id, "key-a"), true);
  assert.equal((await tickets.getQuotaRecoveryTicket(item.id, "key-a"))?.state, "cancelled");
  assert.ok((await tickets.expireQuotaRecoveryTickets(new Date("2026-09-30T00:00:00Z"))) >= 2);
  const raw = await getTestBackend().queryOne<{
    request_ciphertext: string;
    result_ciphertext: string | null;
  }>(
    "SELECT request_ciphertext, result_ciphertext FROM quota_recovery_tickets WHERE turn_key = $1",
    ["session-1/turn-2"]
  );
  assert.ok(raw);
  assert.equal(raw.request_ciphertext, "");
  assert.equal(raw.result_ciphertext, null);
});
