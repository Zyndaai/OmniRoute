// A batch flush that settles while the budget reads the stored total must not make the
// flushed spend vanish from both numbers (stored total read before the commit, pending
// buffer read after the flush cleared it). That would let a spent budget fail open.
import test from "node:test";
import assert from "node:assert/strict";

import { SpendBatchWriter } from "../../src/lib/spend/batchWriter.ts";
import { storedPlusPending } from "../../src/domain/costRules.ts";

const quiet = { log: () => {}, error: () => {} };

test("a flush that settles during the stored-total read is still counted", async () => {
  const table: number[] = [];
  const writer = new SpendBatchWriter({
    logger: quiet,
    persistEntries: (entries) => {
      for (const e of entries) table.push(e.cost);
    },
  });
  writer.increment("key-1", 25);

  let reads = 0;
  const readStored = async () => {
    const snapshot = table.reduce((a, b) => a + b, 0);
    reads++;
    // The first read is taken before the flush commits; the flush settles before it returns.
    if (reads === 1) await writer.flush();
    return snapshot;
  };
  const readPending = () => writer.getPendingCostTotal("key-1");

  const total = await storedPlusPending(readStored, readPending, writer);
  assert.equal(total, 25);
  assert.equal(reads, 2, "re-reads after a flush settled mid-read");
});

test("without a concurrent flush the total is read once", async () => {
  const writer = new SpendBatchWriter({ logger: quiet, persistEntries: () => {} });
  writer.increment("key-1", 3);
  let reads = 0;
  const total = await storedPlusPending(
    async () => {
      reads++;
      return 10;
    },
    () => writer.getPendingCostTotal("key-1"),
    writer
  );
  assert.equal(total, 13);
  assert.equal(reads, 1);
});
