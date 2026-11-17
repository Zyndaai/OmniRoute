/**
 * GHSA-wvxc-jp3v-5mg5 — DELETE /api/v1/batches/delete-completed dropped the
 * ownership predicate that every sibling batch operation keeps.
 *
 * `listBatches(apiKeyId?)` / `countBatches(apiKeyId?)` take the caller's key and
 * scope the SQL to `api_key_id = ?`, falling back to instance-wide only when the
 * caller is an authenticated dashboard session. `deleteCompletedBatches()` took
 * no such argument, so any valid inference key — including one with
 * `scopes: []` — deleted every completed batch on the instance and nulled the
 * content of the files those batches referenced.
 *
 * These tests pin the DB-level contract:
 *   - `{ apiKeyId }` sweeps only that key's completed batches;
 *   - `{ allTenants: true }` is the ONLY way to sweep the whole instance — an
 *     empty/missing apiKeyId throws instead of silently widening the sweep;
 *   - batches with `api_key_id IS NULL` are deliberately OUT of a key-scoped
 *     sweep (strict — diverges from the single-batch `scopeCheck` on purpose);
 *   - each chunk is atomic: a failure after the file soft-deletes rolls the file
 *     content of that chunk back, so no batch row is left pointing at a nulled
 *     file; BOTH modes commit per chunk of INSTANCE_SWEEP_CHUNK ids, so the
 *     write lock is never held across chunks (omni-code-sec LEDGER-4/20/21);
 *   - the chunk loop must make progress: a DELETE that silently removes nothing
 *     throws instead of re-selecting the same chunk forever (LEDGER-22);
 *   - a scope naming BOTH `apiKeyId` and `allTenants` is rejected by the
 *     presence of the field, not its truthiness (LEDGER-18);
 *   - a file soft-delete failure is logged, not swallowed, and the batch rows
 *     are still swept.
 *
 * Self-isolating: DATA_DIR is pointed at a fresh temp dir BEFORE any `@/lib/db/*`
 * module loads (dynamic imports below), so this file never touches ~/.omniroute
 * even when run without tests/_setup/isolateDataDir.ts.
 */
import { describe, it, before, beforeEach, after, mock } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wvxc-"));
process.env.DATA_DIR = TEST_DATA_DIR;
// The soft-delete-failure test observes `log.warn`; pin the level so the assertion
// does not depend on the ambient APP_LOG_LEVEL (a documented setting like `error` would hide it).
process.env.APP_LOG_LEVEL = "warn";

const { createFile, getFile, getFileContent } = await import("../../src/lib/db/files.ts");
const { createBatch, getBatch, updateBatch, deleteCompletedBatches, INSTANCE_SWEEP_CHUNK } =
  await import("../../src/lib/db/batches.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const { getTestBackend, resetTestDb } = await import("../helpers/postgres.ts");

/** One completed batch owned by `apiKeyId`, with its input file. */
async function seedCompletedBatch(apiKeyId: string | null, label: string) {
  const file = await createFile({
    bytes: 8,
    filename: `${label}.jsonl`,
    purpose: "batch",
    content: Buffer.from(label),
    apiKeyId,
  });
  const batch = await createBatch({
    endpoint: "/v1/chat/completions",
    completionWindow: "24h",
    inputFileId: file.id,
    status: "completed",
    apiKeyId,
  });
  return { file, batch };
}

// Test-side failure injection with plpgsql triggers on `batches` / `files`.
// `wvxc_raise` aborts the statement with the message passed as the trigger argument;
// `wvxc_ignore` turns a row DELETE into a silent no-op (the PostgreSQL RAISE(IGNORE)).
async function createFailureFunctions() {
  const b = getTestBackend();
  await b.execute(
    `CREATE OR REPLACE FUNCTION wvxc_raise() RETURNS trigger LANGUAGE plpgsql AS
     $$ BEGIN RAISE EXCEPTION '%', TG_ARGV[0]; END $$`
  );
  await b.execute(
    `CREATE OR REPLACE FUNCTION wvxc_ignore() RETURNS trigger LANGUAGE plpgsql AS
     $$ BEGIN RETURN NULL; END $$`
  );
}

/** Runs `fn` with a trigger installed, always dropping it afterwards. `whenSql` may embed a
 *  generated batch id: DDL cannot take bound parameters. */
async function withTrigger<T>(
  name: string,
  table: "batches" | "files",
  event: "DELETE" | "UPDATE",
  fnCall: string,
  whenSql: string | null,
  fn: () => Promise<T>
): Promise<T> {
  const b = getTestBackend();
  await b.execute(
    `CREATE TRIGGER ${name} BEFORE ${event} ON ${table} FOR EACH ROW ${
      whenSql ? `WHEN (${whenSql})` : ""
    } EXECUTE FUNCTION ${fnCall}`
  );
  try {
    return await fn();
  } finally {
    await b.execute(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
  }
}

/** Makes every batch of `older` sweep before every batch of `newer` (created_at is in seconds). */
async function pinCreatedAt(
  older: Array<{ batch: { id: string } }>,
  newer: Array<{ batch: { id: string } }>
) {
  const base = Math.floor(Date.now() / 1000) - 1000;
  for (const s of older) await updateBatch(s.batch.id, { createdAt: base });
  for (const s of newer) await updateBatch(s.batch.id, { createdAt: base + 1 });
}

/** Counts `transaction()` invocations on the process backend. */
function spyTransactions() {
  const backend = getTestBackend();
  const orig = backend.transaction.bind(backend);
  let runs = 0;
  const spy = mock.method(backend, "transaction", ((fn: never) => {
    runs++;
    return orig(fn);
  }) as typeof backend.transaction);
  return { runs: () => runs, restore: () => spy.mock.restore() };
}

describe("deleteCompletedBatches — ownership boundary (GHSA-wvxc-jp3v-5mg5)", () => {
  before(async () => {
    await createFailureFunctions();
  });

  beforeEach(async () => {
    await resetTestDb();
    await createFailureFunctions();
  });

  after(async () => {
    await resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("deletes only the caller's completed batches, never another key's", async () => {
    const attacker = await seedCompletedBatch("key_attacker_wvxc", "wvxc-attacker");
    const victim = await seedCompletedBatch("key_victim_wvxc", "wvxc-victim");

    const result = await deleteCompletedBatches({ apiKeyId: "key_attacker_wvxc" });

    assert.strictEqual(
      await getBatch(attacker.batch.id),
      null,
      "the caller's own completed batch should be deleted"
    );
    assert.ok(
      await getBatch(victim.batch.id),
      "another key's completed batch must survive — this is the vulnerability"
    );
    assert.ok(
      await getFile(victim.file.id),
      "another key's file content must not be cleared by a foreign caller"
    );
    assert.strictEqual(result.deletedBatches, 1, "only one batch belonged to the caller");
  });

  it("leaves a batch that is not completed alone, even when the caller owns it", async () => {
    const own = await seedCompletedBatch("key_owner_wvxc", "wvxc-owner");
    const inProgressFile = await createFile({
      bytes: 8,
      filename: "wvxc-inprogress.jsonl",
      purpose: "batch",
      content: Buffer.from("running"),
      apiKeyId: "key_owner_wvxc",
    });
    const inProgress = await createBatch({
      endpoint: "/v1/chat/completions",
      completionWindow: "24h",
      inputFileId: inProgressFile.id,
      status: "in_progress",
      apiKeyId: "key_owner_wvxc",
    });

    await deleteCompletedBatches({ apiKeyId: "key_owner_wvxc" });

    assert.strictEqual(await getBatch(own.batch.id), null, "completed batch of the caller goes");
    assert.ok(await getBatch(inProgress.id), "an in-progress batch is never swept");
  });

  it("keeps the instance-wide sweep only for the explicit allTenants scope", async () => {
    const a = await seedCompletedBatch("key_a_wvxc_global", "wvxc-global-a");
    const b = await seedCompletedBatch("key_b_wvxc_global", "wvxc-global-b");

    await deleteCompletedBatches({ allTenants: true });

    assert.strictEqual(await getBatch(a.batch.id), null, "session sweep clears every key");
    assert.strictEqual(await getBatch(b.batch.id), null, "session sweep clears every key");
  });

  it("throws on a missing/empty apiKeyId instead of silently sweeping the instance", async () => {
    const survivor = await seedCompletedBatch("key_survivor_wvxc", "wvxc-survivor");

    await assert.rejects(
      () => deleteCompletedBatches({ apiKeyId: "" }),
      /apiKeyId required unless allTenants/
    );
    await assert.rejects(
      // A caller that forgot the scope entirely (JS caller / `any` cast) must not
      // fall through to an instance-wide sweep either.
      () => (deleteCompletedBatches as unknown as (s?: unknown) => Promise<unknown>)(),
      /apiKeyId required unless allTenants/
    );
    await assert.rejects(
      () =>
        (deleteCompletedBatches as unknown as (s: unknown) => Promise<unknown>)({
          apiKeyId: null,
          allTenants: false,
        }),
      /apiKeyId required unless allTenants/
    );
    assert.ok(await getBatch(survivor.batch.id), "a rejected call must not delete anything");
    assert.strictEqual(
      (await getFileContent(survivor.file.id))?.toString(),
      "wvxc-survivor",
      "a rejected call must not null file content"
    );

    await deleteCompletedBatches({ apiKeyId: "key_survivor_wvxc" });
  });

  it("rejects a scope carrying both apiKeyId and allTenants instead of silently widening", async () => {
    const survivor = await seedCompletedBatch("key_mixed_wvxc", "wvxc-mixed");
    await assert.rejects(
      () =>
        (deleteCompletedBatches as unknown as (s: unknown) => Promise<unknown>)({
          apiKeyId: "key_mixed_wvxc",
          allTenants: true,
        }),
      /mutually exclusive/
    );
    assert.ok(await getBatch(survivor.batch.id), "a rejected mixed scope must not delete anything");
    await deleteCompletedBatches({ apiKeyId: "key_mixed_wvxc" });
  });

  it("rejects allTenants combined with an EMPTY or NULL apiKeyId too — the field's presence decides, not its truthiness (LEDGER-18)", async () => {
    const survivor = await seedCompletedBatch("key_presence_wvxc", "wvxc-presence");
    await assert.rejects(
      () => deleteCompletedBatches({ allTenants: true, apiKeyId: "" } as never),
      /mutually exclusive/
    );
    await assert.rejects(
      () => deleteCompletedBatches({ allTenants: true, apiKeyId: null } as never),
      /mutually exclusive/
    );
    assert.ok(
      await getBatch(survivor.batch.id),
      "a rejected mixed scope must not sweep the instance"
    );
    assert.strictEqual(
      (await getFileContent(survivor.file.id))?.toString(),
      "wvxc-presence",
      "a rejected mixed scope must not null file content"
    );
    await deleteCompletedBatches({ apiKeyId: "key_presence_wvxc" });
  });

  it("STRICT: a batch with api_key_id NULL stays out of a key-scoped sweep (diverges from scopeCheck on purpose)", async () => {
    const unowned = await seedCompletedBatch(null, "wvxc-unowned");
    const own = await seedCompletedBatch("key_strict_wvxc", "wvxc-strict-own");

    const scoped = await deleteCompletedBatches({ apiKeyId: "key_strict_wvxc" });

    assert.strictEqual(scoped.deletedBatches, 1, "only the key's own batch is counted");
    assert.strictEqual(await getBatch(own.batch.id), null, "the key's own batch goes");
    assert.ok(await getBatch(unowned.batch.id), "the NULL-owned batch survives a key-scoped sweep");
    assert.ok(await getFile(unowned.file.id), "the NULL-owned batch's file survives");
    assert.strictEqual(
      (await getFileContent(unowned.file.id))?.toString(),
      "wvxc-unowned",
      "the NULL-owned batch's file content is intact"
    );

    const instanceWide = await deleteCompletedBatches({ allTenants: true });

    assert.ok(instanceWide.deletedBatches >= 1, "the allTenants sweep reaches unowned batches");
    assert.strictEqual(
      await getBatch(unowned.batch.id),
      null,
      "allTenants removes the NULL-owned batch"
    );
    assert.strictEqual(
      await getFile(unowned.file.id),
      null,
      "allTenants soft-deletes its file too"
    );
  });

  it("SEC-C: a key-scoped sweep never nulls a file another key owns, even when its own batch references it", async () => {
    const foreignFile = await createFile({
      bytes: 7,
      filename: "foreign.jsonl",
      purpose: "batch",
      content: Buffer.from("foreign"),
      apiKeyId: "key-other",
    });
    const unownedFile = await createFile({
      bytes: 7,
      filename: "unowned.jsonl",
      purpose: "batch",
      content: Buffer.from("unowned"),
      apiKeyId: null,
    });
    const own = await seedCompletedBatch("key-secc", "secc-own");
    const cross = await createBatch({
      endpoint: "/v1/chat/completions",
      completionWindow: "24h",
      inputFileId: foreignFile.id,
      outputFileId: unownedFile.id,
      status: "completed",
      apiKeyId: "key-secc",
    });

    const result = await deleteCompletedBatches({ apiKeyId: "key-secc" });

    assert.strictEqual(result.deletedBatches, 2, "both of the key's completed batches are swept");
    assert.strictEqual(result.deletedFiles, 1, "only the key's OWN file is soft-deleted");
    assert.strictEqual(await getBatch(own.batch.id), null);
    assert.strictEqual(await getBatch(cross.id), null);
    assert.strictEqual(await getFileContent(own.file.id), null, "own file content nulled");
    assert.strictEqual(
      (await getFileContent(foreignFile.id))?.toString(),
      "foreign",
      "another key's file intact"
    );
    assert.strictEqual(
      (await getFileContent(unownedFile.id))?.toString(),
      "unowned",
      "unowned file intact"
    );
  });

  it("ATOMIC: a failure after the file soft-deletes rolls the file content back", async () => {
    const own = await seedCompletedBatch("key_atomic_wvxc", "wvxc-atomic");

    // Test-side failure injection: make the final `DELETE FROM batches` abort. The
    // file soft-deletes and the checkpoint DELETE run before it, so without a
    // transaction the batch row would survive pointing at a nulled file.
    await withTrigger(
      "wvxc_abort_batch_delete",
      "batches",
      "DELETE",
      "wvxc_raise('wvxc injected failure')",
      null,
      async () => {
        await assert.rejects(
          () => deleteCompletedBatches({ apiKeyId: "key_atomic_wvxc" }),
          /wvxc injected failure/
        );
      }
    );

    const batch = await getBatch(own.batch.id);
    assert.ok(batch, "the batch row is still there after the failed sweep");
    assert.ok(
      await getFile(own.file.id),
      "the referenced file is not soft-deleted after the failed sweep"
    );
    assert.strictEqual(
      (await getFileContent(own.file.id))?.toString(),
      "wvxc-atomic",
      "the file content was rolled back — no batch row points at a nulled file"
    );

    // Sanity: without the injected failure the sweep completes normally.
    const result = await deleteCompletedBatches({ apiKeyId: "key_atomic_wvxc" });
    assert.strictEqual(result.deletedBatches, 1);
    assert.strictEqual(result.deletedFiles, 1);
    assert.strictEqual(await getFile(own.file.id), null);
  });

  it("logs (does not swallow) a file soft-delete failure and still sweeps the batch rows", async () => {
    const own = await seedCompletedBatch("key_filefail_wvxc", "wvxc-filefail");
    const warn = mock.method(console, "warn", () => {});

    let result: { deletedBatches: number; deletedFiles: number };
    try {
      result = await withTrigger(
        "wvxc_abort_file_update",
        "files",
        "UPDATE",
        "wvxc_raise('wvxc file failure')",
        null,
        () => deleteCompletedBatches({ apiKeyId: "key_filefail_wvxc" })
      );
    } finally {
      warn.mock.restore();
    }

    assert.strictEqual(result.deletedBatches, 1, "batch rows are swept even when a file fails");
    assert.strictEqual(result.deletedFiles, 0, "a failed soft-delete is not counted");
    assert.strictEqual(await getBatch(own.batch.id), null);
    const logged = warn.mock.calls
      .map((c) => c.arguments.map((a) => String(a)).join(" "))
      .find((line) => line.includes("deleteCompletedBatches: file soft-delete failed"));
    assert.ok(logged, "the failure is logged at warn level");
    assert.ok(logged!.includes(own.file.id), "the log line names the file id");
  });

  it("SEC-D: the instance sweep runs in chunks of INSTANCE_SWEEP_CHUNK and still deletes everything", async () => {
    const total = INSTANCE_SWEEP_CHUNK * 2 + 50; // 3 chunks: 200 + 200 + 50
    const ids: string[] = [];
    for (let i = 0; i < total; i++)
      ids.push((await seedCompletedBatch(i % 2 ? "key-chunk-a" : null, `chunk-${i}`)).batch.id);
    // What must happen per chunk is one `transaction()` call — count those.
    const txSpy = spyTransactions();

    let result: Awaited<ReturnType<typeof deleteCompletedBatches>>;
    try {
      result = await deleteCompletedBatches({ allTenants: true });
    } finally {
      txSpy.restore();
    }

    assert.strictEqual(result.deletedBatches, total);
    assert.strictEqual(result.deletedFiles, total);
    assert.strictEqual(txSpy.runs(), 3, "one transaction per chunk (200 + 200 + 50)");
    for (const id of ids) assert.strictEqual(await getBatch(id), null);
  });

  it("SEC-D: a failure in chunk 2 keeps chunk 1 done and rolls chunk 2 back entirely", async () => {
    const first = [];
    for (let i = 0; i < INSTANCE_SWEEP_CHUNK; i++)
      first.push(await seedCompletedBatch(null, `c1-${i}`));
    const second = [];
    for (let i = 0; i < 10; i++) second.push(await seedCompletedBatch(null, `c2-${i}`));
    // The sweep orders by (created_at seconds, id): pin the order so chunk 1 is `first`.
    await pinCreatedAt(first, second);
    const poison = second[5].batch.id;
    // DDL cannot take bound parameters; the value is createBatch's generated id.
    await withTrigger(
      "wvxc_chunk_poison",
      "batches",
      "DELETE",
      "wvxc_raise('poison')",
      `OLD.id = '${poison}'`,
      async () => {
        await assert.rejects(() => deleteCompletedBatches({ allTenants: true }), /poison/);
      }
    );
    for (const s of first) assert.strictEqual(await getBatch(s.batch.id), null, "chunk 1 committed");
    for (const s of second) {
      assert.ok(await getBatch(s.batch.id), "chunk 2 rolled back as a unit");
      assert.strictEqual(
        (await getFileContent(s.file.id))?.toString(),
        s.file.filename.replace(".jsonl", ""),
        "chunk 2 file content restored"
      );
    }
  });

  it("SEC-D: a key with more than INSTANCE_SWEEP_CHUNK completed batches is swept in one call, one commit per chunk", async () => {
    const total = INSTANCE_SWEEP_CHUNK + 1;
    const own = [];
    for (let i = 0; i < total; i++) own.push(await seedCompletedBatch("key-big", `big-${i}`));
    const other = await seedCompletedBatch("key-small", "big-other");
    const txSpy = spyTransactions();
    let result: Awaited<ReturnType<typeof deleteCompletedBatches>>;
    try {
      result = await deleteCompletedBatches({ apiKeyId: "key-big" });
    } finally {
      txSpy.restore();
    }
    assert.strictEqual(result.deletedBatches, total);
    assert.strictEqual(result.deletedFiles, total);
    assert.strictEqual(txSpy.runs(), 2, "two chunk units (200 + 1) and NO outer transaction");
    for (const s of own) assert.strictEqual(await getBatch(s.batch.id), null);
    assert.ok(await getBatch(other.batch.id), "another key's batch survives");
  });

  it("a failure in the key sweep's second chunk keeps chunk 1 committed and rolls chunk 2 back (per-chunk atomicity, same as instance mode)", async () => {
    const own = [];
    for (let i = 0; i < INSTANCE_SWEEP_CHUNK + 5; i++)
      own.push(await seedCompletedBatch("key-perchunk", `perchunk-${i}`));
    const first = own.slice(0, INSTANCE_SWEEP_CHUNK);
    const second = own.slice(INSTANCE_SWEEP_CHUNK);
    // The sweep orders by (created_at seconds, id): pin the order so chunk 1 is `first`.
    await pinCreatedAt(first, second);
    const poison = second[2].batch.id;
    // DDL cannot take bound parameters; the value is createBatch's generated id.
    await withTrigger(
      "wvxc_key_poison",
      "batches",
      "DELETE",
      "wvxc_raise('key poison')",
      `OLD.id = '${poison}'`,
      async () => {
        await assert.rejects(
          () => deleteCompletedBatches({ apiKeyId: "key-perchunk" }),
          /key poison/
        );
      }
    );
    for (const s of first) {
      assert.strictEqual(
        await getBatch(s.batch.id),
        null,
        "chunk 1 committed before chunk 2 failed"
      );
      assert.strictEqual(await getFile(s.file.id), null, "chunk 1's file soft-deleted with it");
    }
    for (const s of second) {
      assert.ok(await getBatch(s.batch.id), "chunk 2 rolled back as a unit");
      assert.strictEqual(
        (await getFileContent(s.file.id))?.toString(),
        s.file.filename.replace(".jsonl", ""),
        "chunk 2 file content restored"
      );
    }
    // The survivors are swept normally once the poison is gone.
    const rest = await deleteCompletedBatches({ apiKeyId: "key-perchunk" });
    assert.strictEqual(rest.deletedBatches, second.length);
  });

  it("FORWARD PROGRESS: a chunk whose DELETE silently removes nothing throws instead of looping forever (LEDGER-22)", async () => {
    const own = await seedCompletedBatch("key-noprog", "noprog-0");
    // A row trigger returning NULL turns the DELETE into a silent no-op: the row
    // survives, the next chunk selects the same id again, and the loop would never end.
    await withTrigger(
      "wvxc_noprog",
      "batches",
      "DELETE",
      "wvxc_ignore()",
      "OLD.api_key_id = 'key-noprog'",
      async () => {
        await assert.rejects(() => deleteCompletedBatches({ apiKeyId: "key-noprog" }), /no progress/);
      }
    );
    assert.ok(await getBatch(own.batch.id), "the row the DELETE ignored is still there");
    const result = await deleteCompletedBatches({ apiKeyId: "key-noprog" });
    assert.strictEqual(result.deletedBatches, 1, "sweeps normally once the DELETE works again");
  });
});
