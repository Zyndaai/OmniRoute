// One API key must not crowd out the others: a key holds a bounded number of active recovery
// tickets, each scheduler tick takes due tickets round-robin across keys, and finished rows are
// purged a day after they expire.
import test from "node:test";
import assert from "node:assert/strict";
import { getTestBackend, resetTestDb } from "../../helpers/postgres.ts";

process.env.STORAGE_ENCRYPTION_KEY = "quota-recovery-limit-test-key";

const tickets = await import("../../../src/lib/db/quotaRecoveryTickets.ts");

test.beforeEach(async () => {
  await resetTestDb();
});

const DUE = "2026-09-28T09:00:00.000Z";
const EXPIRES = "2026-09-29T09:00:00.000Z";

function input(apiKeyId: string, turn: string, maxActivePerKey?: number, nextAttemptAt = DUE) {
  return {
    apiKeyId,
    turnKey: turn,
    endpoint: "chat/completions" as const,
    requestPayload: JSON.stringify({ turn }),
    nextAttemptAt,
    expiresAt: EXPIRES,
    maxActivePerKey,
  };
}

test("a key at its limit cannot queue a new turn; other keys and repeats are unaffected", async () => {
  const first = await tickets.enqueueQuotaRecoveryTicket(input("key-a", "t1", 2));
  await tickets.enqueueQuotaRecoveryTicket(input("key-a", "t2", 2));
  await assert.rejects(
    () => tickets.enqueueQuotaRecoveryTicket(input("key-a", "t3", 2)),
    tickets.QuotaRecoveryTicketLimitError
  );
  // The same turn again returns its ticket instead of counting as a new one.
  assert.equal((await tickets.enqueueQuotaRecoveryTicket(input("key-a", "t1", 2))).id, first.id);
  await tickets.enqueueQuotaRecoveryTicket(input("key-b", "t1", 2));

  // A finished ticket frees its slot.
  assert.equal(await tickets.cancelQuotaRecoveryTicket(first.id, "key-a"), true);
  await tickets.enqueueQuotaRecoveryTicket(input("key-a", "t3", 2));
});

test("concurrent turns of one key cannot pass the limit together", async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, (_, i) =>
      tickets.enqueueQuotaRecoveryTicket(input("key-a", `c${i}`, 2))
    )
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  for (const r of results) {
    if (r.status === "rejected")
      assert.ok(r.reason instanceof tickets.QuotaRecoveryTicketLimitError);
  }
});

test("due tickets are taken round-robin across keys", async () => {
  for (let i = 0; i < 4; i++) {
    await tickets.enqueueQuotaRecoveryTicket(
      input("key-busy", `b${i}`, undefined, `2026-09-28T08:0${i}:00.000Z`)
    );
  }
  await tickets.enqueueQuotaRecoveryTicket(input("key-quiet", "q0", undefined, DUE));

  const due = await tickets.listDueQuotaRecoveryTickets(new Date("2026-09-28T10:00:00Z"), 2);
  assert.deepEqual(due.map((t) => t.apiKeyId).sort(), ["key-busy", "key-quiet"]);
  assert.equal(
    due.find((t) => t.apiKeyId === "key-busy")?.turnKey,
    "b0",
    "oldest of the key first"
  );
});

test("expired and cancelled rows are deleted only after the retention period", async () => {
  const old = await tickets.enqueueQuotaRecoveryTicket({
    ...input("key-a", "old"),
    expiresAt: DUE,
  });
  const recent = await tickets.enqueueQuotaRecoveryTicket({
    ...input("key-a", "new"),
    expiresAt: EXPIRES,
  });
  const live = await tickets.enqueueQuotaRecoveryTicket(input("key-a", "live"));
  await tickets.expireQuotaRecoveryTickets(new Date("2026-09-29T09:00:01Z"));

  const purged = await tickets.purgeFinishedQuotaRecoveryTickets(
    new Date("2026-09-29T12:00:00Z"),
    24 * 60 * 60_000
  );
  assert.equal(purged, 1);
  const ids = (
    await getTestBackend().query<{ id: string }>("SELECT id FROM quota_recovery_tickets")
  ).map((r) => r.id);
  assert.ok(!ids.includes(old.id), "expired more than a day ago: deleted");
  assert.ok(ids.includes(recent.id), "expired less than a day ago: kept");
  assert.ok(ids.includes(live.id));
});
