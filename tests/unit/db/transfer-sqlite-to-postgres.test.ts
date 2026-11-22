/**
 * The SQLite -> PostgreSQL transfer tool (src/lib/db/backends/transfer/), against production's
 * own schema (tests/fixtures/transfer/prod-sqlite-schema.sql, DDL only) filled with rows that
 * exercise each mapping rule production's data hits. Needs OMNIROUTE_TEST_POSTGRES_URL (an
 * admin URL); each case creates its own empty target database. Works with or without
 * tests/_setup/isolatePostgres.ts: the test points the app's settings reader at the transfer
 * target before the app opens its first connection.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import pg from "pg";

const adminUrl = process.env.OMNIROUTE_TEST_POSTGRES_URL?.trim();
const skip = adminUrl ? false : "OMNIROUTE_TEST_POSTGRES_URL is not set";

const { runTransfer, transferMigrationsDir } =
  await import("../../../src/lib/db/backends/transfer/transfer.ts");
const { parseEnumCheck } = await import("../../../src/lib/db/backends/transfer/catalog.ts");
const { parseInstant } = await import("../../../src/lib/db/backends/transfer/convert.ts");

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-transfer-"));
const createdDatabases: string[] = [];

async function adminQuery(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function newTargetDb(): Promise<string> {
  const name = `omni_xfer_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await adminQuery(
    `CREATE DATABASE ${name} TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C' ENCODING 'UTF8'`
  );
  createdDatabases.push(name);
  const url = new URL(adminUrl!);
  url.pathname = `/${name}`;
  return url.toString();
}

test.after(async () => {
  const backend = (globalThis as { __omnirouteDbBackend?: { close(): Promise<void> } })
    .__omnirouteDbBackend;
  await backend?.close().catch(() => {});
  for (const name of createdDatabases) {
    await adminQuery(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
  }
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** A SQLite file with production's schema (FTS shadow tables are created by SQLite itself). */
function newSourceDb(): { file: string; db: Database.Database } {
  const file = path.join(workDir, `${randomUUID()}.sqlite`);
  const db = new Database(file);
  const ddl = fs
    .readFileSync(path.resolve("tests/fixtures/transfer/prod-sqlite-schema.sql"), "utf8")
    .replace(/^CREATE TABLE 'memory_fts_\w+'[^;]*;\n/gm, "");
  db.exec(ddl);
  return { file, db };
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const kv = (db: Database.Database, namespace: string, key: string, value: string) =>
  db
    .prepare("INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?)")
    .run(namespace, key, value);

/** The rows production's data exercises, one or two per rule. */
function fillProductionShapes(db: Database.Database) {
  // Migration 046's seed rows only: the flat retention keys must survive as 90 / 365.
  for (const [key, value] of Object.entries({
    callLogs: 90,
    usageHistory: 365,
    quotaSnapshots: 90,
    autoCleanupEnabled: true,
    callLogPipelineEnabled: true,
    aggregationEnabled: false,
    autoVacuumMode: "INCREMENTAL",
  })) {
    kv(db, "databaseSettings", key, JSON.stringify(value));
  }
  kv(db, "settings", "call_log_pipeline_enabled", "0");
  kv(db, "settings", "mcpEnabled", "true");
  kv(db, "settings", "legacyRawSetting", "not json at all");
  kv(db, "settings", "model_sync_last_run", '"2026-11-20T10:00:00.000Z"');
  kv(db, "feature_flags", "SOME_FLAG", "true");
  kv(db, "gamification:streaks", "user-1", '{"days":3}');
  kv(db, "scheduler", "vacuum", '{"lastRunAt":1}');
  kv(db, "syncedAvailableModels", "openai:conn-1", '[{"id":"gpt-x"}]');
  kv(db, "syncedAvailableModels", "openai:gone", '[{"id":"gpt-y"}]');
  kv(
    db,
    "discoveryState",
    "openai:conn-1",
    '{"status":"healthy","cause":null,"at":"2026-11-20T09:00:00.000Z"}'
  );
  kv(
    db,
    "discoveryState",
    "openai:conn-2",
    '{"status":"mystery","cause":null,"at":"2026-11-20T09:00:00.000Z"}'
  );
  kv(db, "syncedAvailableModels", "openai:conn-2", '[{"id":"gpt-z"}]');
  kv(db, "providerLimitsCache", "conn-1", '{"limits":[]}');
  kv(db, "lkgp", "combo-a:gpt-x", '{"provider":"openai","connectionId":"conn-1"}');
  kv(db, "modelAliases", "fast", '"openai/gpt-x"');
  kv(db, "managedModelAliasNames", "names", '["fast"]');
  kv(db, "customModels", "openai", '[{"id":"my-model"}]');
  const now = Date.now();
  kv(
    db,
    "gemini_thought_signatures",
    "sig-valid",
    JSON.stringify({ signature: "abc", createdAt: now, expiresAt: now + 3_600_000 })
  );
  kv(
    db,
    "gemini_thought_signatures",
    "sig-expired",
    JSON.stringify({ signature: "old", createdAt: now - 10, expiresAt: now - 5 })
  );
  kv(db, "interception_rules", "openai", '{"rules":[]}');
  kv(db, "compression", "mode", '"auto"');

  db.prepare(
    `INSERT INTO provider_connections (id, provider, name, api_key, is_active, "group", rate_limit_overrides_json,
       rate_limited_until, created_at, updated_at)
     VALUES ('conn-1', 'openai', 'main', 'sk-plain', 1, 'team-a', '{"rpm":10}', ?, '2026-11-01 08:00:00', '2026-11-02T08:00:00.000Z')`
  ).run(now + 60_000);
  db.prepare(
    "INSERT INTO provider_connections (id, provider, name, created_at, updated_at) VALUES ('conn-2', 'openai', 'second', '2026-11-01 08:00:00', '2026-11-01 08:00:00')"
  ).run();
  db.prepare(
    `INSERT INTO provider_nodes (id, type, name, prefix, custom_headers_json, created_at, updated_at)
     VALUES ('node-1', 'openai-compatible', 'Mock', '   ', '{"x-a":"b"}', '2026-11-01 08:00:00', '2026-11-01 08:00:00')`
  ).run();
  db.prepare(
    "INSERT INTO api_keys (id, name, key, key_hash, created_at) VALUES ('key-1', 'production', 'sk-live-123', ?, '2026-11-01T00:00:00.000Z')"
  ).run(sha256("sk-live-123"));
  db.prepare(
    "INSERT INTO call_logs (id, timestamp, method, path, status, provider, model) VALUES ('log-a', '2026-11-10T12:00:00.000Z', 'POST', '/v1/chat/completions', 200, 'openai', 'gpt-x')"
  ).run();
  db.prepare(
    "INSERT INTO call_logs (id, timestamp, method, path, status, provider, model) VALUES ('log-b', '2026-11-12T23:59:59.000Z', 'POST', '/v1/chat/completions', 500, 'openai', 'gpt-x')"
  ).run();
  db.prepare(
    "INSERT INTO usage_history (provider, model, connection_id, tokens_input, tokens_output, success, timestamp) VALUES ('openai', 'gpt-x', 'conn-1', NULL, 12.6, 1, '2026-11-10 12:00:00')"
  ).run();
  for (const [model, usedAt] of [
    ["gpt-old", "2026-11-10 10:00:00"],
    ["gpt-new", "2026-11-10 11:00:00"],
    ["gpt-mid", "2026-11-10 10:30:00"],
  ]) {
    db.prepare(
      "INSERT INTO session_model_history (session_id, combo_name, model_str, provider, connection_id, used_at) VALUES ('s1', 'combo-a', ?, 'openai', 'conn-1', ?)"
    ).run(model, usedAt);
  }
  db.prepare(
    "INSERT INTO api_key_quota_counters (api_key_id, dimension_key, bucket_index, consumed, updated_at) VALUES ('key-1', 'key-quota:rpm', 29000000, 3.5, ?)"
  ).run(now);
  db.prepare(
    "INSERT INTO audit_log (action, details, timestamp) VALUES ('login', 'plain text, not json', '2026-11-10 12:00:00')"
  ).run();
  db.prepare(
    "INSERT INTO version_manager (tool, status) VALUES ('cliproxyapi', 'weird-status')"
  ).run();
  db.prepare(
    `INSERT INTO agentic_conversations (id, fingerprint_hash, last_message_count, last_messages_hash, first_seen_at, last_seen_at)
     VALUES ('conv-1', 'fp', 3, 'h', '2026-11-10 10:00:00', '2026-11-10 11:00:00')`
  ).run();
  db.prepare(
    "INSERT INTO conversation_turn_nodes (id, conversation_id, role, first_seen_at, last_seen_at) VALUES ('turn-1', 'conv-1', 'user', '2026-11-10 10:00:00', '2026-11-10 10:00:00')"
  ).run();
  db.prepare(
    "INSERT INTO conversation_turn_nodes (id, conversation_id, role, first_seen_at, last_seen_at) VALUES ('turn-orphan', 'conv-missing', 'user', '2026-11-10 10:00:00', '2026-11-10 10:00:00')"
  ).run();
  db.prepare(
    "INSERT OR REPLACE INTO quota_groups (id, name) VALUES ('group-demo', 'Production group')"
  ).run();
  db.prepare(
    "INSERT INTO xp_audit_log (api_key_id, action, xp_earned) VALUES ('key-1', 'chat', 5)"
  ).run();
}

test("parsing helpers: enum CHECKs and the timestamp formats SQLite writers used", () => {
  assert.deepEqual(parseEnumCheck("CHECK ((status = ANY (ARRAY['idle'::text, 'error'::text])))"), {
    column: "status",
    values: ["idle", "error"],
  });
  assert.equal(parseEnumCheck("CHECK ((port > 0))"), null);
  const iso = (v: unknown) => (parseInstant(v) as Date).toISOString();
  assert.equal(
    iso("2026-11-10 12:00:00"),
    "2026-11-10T12:00:00.000Z",
    "datetime('now') text is UTC"
  );
  assert.equal(iso("2026-11-10T12:00:00.000Z"), "2026-11-10T12:00:00.000Z");
  assert.equal(iso(1_763_000_000_000), new Date(1_763_000_000_000).toISOString(), "epoch ms");
  assert.equal(iso(1_763_000_000), new Date(1_763_000_000_000).toISOString(), "epoch seconds");
  assert.equal(parseInstant(""), null);
  assert.ok("problem" in (parseInstant(0) as object), "0 is not an event time");
});

test("transfers production-shaped data and verifies every table", { skip }, async () => {
  const { file, db } = newSourceDb();
  // Like production's database and its backup-API snapshot: WAL mode, cleanly closed.
  db.pragma("journal_mode = WAL");
  fillProductionShapes(db);
  db.close();
  const sourceBefore = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const targetUrl = await newTargetDb();

  const receipt = await runTransfer({ sqlitePath: file, targetUrl });
  assert.equal(receipt.source.sha256, sourceBefore);
  assert.equal(
    createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
    sourceBefore,
    "the source file is never modified"
  );
  assert.equal(fs.existsSync(`${file}-shm`), false, "no -shm created beside the source");
  const bad = receipt.targets.filter(
    (t) => t.verified.mismatchedRows > 0 || t.verified.expected !== t.verified.actual
  );
  assert.deepEqual(
    bad.map((t) => [t.table, t.mismatchSamples]),
    [],
    "every table stores what was meant"
  );
  assert.equal(receipt.ok, true);
  assert.deepEqual(
    receipt.targets.filter((t) => !t.reconciled).map((t) => t.table),
    [],
    "every offered row is written, skipped with a reason, or an orphan"
  );
  // The fixture's deliberate oddities surface for review; the pin dedupe does not.
  for (const expected of [
    /version_manager: 1 value\(s\) status: not-in-allowed-set -> error/,
    /audit_log: 1 value\(s\) details: invalid-json -> kept as a JSON string/,
    /config_entries: 1 value\(s\) value: invalid-json -> kept as a JSON string/,
    /connection_model_sync: 1 value\(s\) discovery_status: not-in-allowed-set -> null/,
    /key_value syncedAvailableModels "openai:gone" skipped: no matching provider connection/,
  ]) {
    assert.ok(
      receipt.review.some((item) => expected.test(item)),
      `review lists ${expected}`
    );
  }
  assert.ok(!receipt.review.some((item) => item.includes("older pin")), "pin dedupe is expected");

  const target = (name: string) => receipt.targets.find((t) => t.table === name);
  const source = (name: string) => receipt.sources.find((s) => s.table === name);

  // The retention the SQLite app enforced survives (the leader's first cleanup reads it).
  assert.equal(receipt.effectiveDatabaseSettings.retention.callLogs, 90);
  assert.equal(receipt.effectiveDatabaseSettings.retention.usageHistory, 365);
  assert.equal(
    receipt.effectiveDatabaseSettings.logs.callLogPipelineEnabled,
    false,
    "runtime flag wins"
  );
  process.env.OMNIROUTE_POSTGRES_URL = targetUrl;
  const { getDatabaseSettingsSection } =
    await import("../../../src/lib/db/databaseSettingsSections.ts");
  const retention = await getDatabaseSettingsSection("retention");
  assert.equal(retention.callLogs, 90, "the app reads 90 days of call logs");
  assert.equal(retention.usageHistory, 365, "the app reads 365 days of usage history");
  assert.equal((await getDatabaseSettingsSection("logs")).callLogPipelineEnabled, false);

  const pgc = new pg.Client({ connectionString: targetUrl });
  await pgc.connect();
  try {
    const one = async (sql: string) => (await pgc.query(sql)).rows[0];
    assert.equal(
      (
        await one(
          "SELECT value FROM config_entries WHERE namespace='settings' AND key='mcpEnabled'"
        )
      ).value,
      true
    );
    assert.equal(
      (
        await one(
          "SELECT value FROM config_entries WHERE namespace='settings' AND key='legacyRawSetting'"
        )
      ).value,
      "not json at all",
      "a non-JSON setting is kept as a JSON string, never dropped"
    );
    assert.ok(
      await one(
        "SELECT 1 FROM config_entries WHERE namespace='job_state' AND key='model_sync_last_run'"
      )
    );
    assert.equal(
      (
        await one(
          "SELECT value FROM config_entries WHERE namespace='feature_flags' AND key='SOME_FLAG'"
        )
      ).value,
      "true",
      "raw text kept as a JSON string"
    );
    assert.equal(
      (await one("SELECT models FROM connection_model_sync WHERE connection_id='conn-1'")).models[0]
        .id,
      "gpt-x"
    );
    assert.equal(
      (await one("SELECT discovery_status FROM connection_model_sync WHERE connection_id='conn-1'"))
        .discovery_status,
      "healthy"
    );
    const unknownStatus = await one(
      "SELECT discovery_status, models FROM connection_model_sync WHERE connection_id='conn-2'"
    );
    assert.deepEqual(
      [unknownStatus.discovery_status, unknownStatus.models[0].id],
      [null, "gpt-z"],
      "an unknown status is nulled, the models kept"
    );
    assert.equal(
      (await one("SELECT count(*)::int n FROM connection_model_sync")).n,
      2,
      "the orphan sync row is skipped"
    );
    assert.equal((await one("SELECT managed FROM model_aliases WHERE alias='fast'")).managed, true);
    assert.equal(
      (await one("SELECT count(*)::int n FROM gemini_thought_signatures")).n,
      1,
      "expired signature skipped"
    );
    const pin = await one(
      "SELECT model_str FROM session_model_pins WHERE combo_name='combo-a' AND session_id='s1'"
    );
    assert.equal(pin.model_str, "gpt-new", "only the latest pin per (combo, session)");
    assert.equal(
      (await one("SELECT consumed::text c FROM quota_counters")).c.startsWith("3.5"),
      true
    );
    const conn = await one(
      "SELECT group_name, rate_limit_overrides, is_active FROM provider_connections"
    );
    assert.deepEqual(
      [conn.group_name, conn.rate_limit_overrides, conn.is_active],
      ["team-a", { rpm: 10 }, true]
    );
    assert.equal(
      (await one("SELECT prefix FROM provider_nodes")).prefix,
      null,
      "blank prefix -> NULL"
    );
    assert.equal((await one("SELECT status FROM version_manager")).status, "error");
    assert.equal(
      (await one("SELECT details FROM audit_log")).details,
      "plain text, not json",
      "J-raw"
    );
    const seqs = (await pgc.query("SELECT id, seq FROM call_logs ORDER BY id")).rows.map((r) => [
      r.id,
      Number(r.seq),
    ]);
    assert.deepEqual(
      seqs,
      [
        ["log-a", 1],
        ["log-b", 2],
      ],
      "seq is the SQLite rowid"
    );
    const homes = (
      await pgc.query("SELECT id, tableoid::regclass::text AS part FROM call_logs ORDER BY id")
    ).rows;
    assert.deepEqual(
      homes.map((r) => r.part),
      ["call_logs_p20261110", "call_logs_p20261112"],
      "each row lands in its day partition, not the default one"
    );
    const usage = await one("SELECT tokens_input, tokens_output FROM usage_history");
    assert.deepEqual(
      [Number(usage.tokens_input), Number(usage.tokens_output)],
      [0, 13],
      "NULL -> 0, REAL rounded"
    );
    assert.equal(
      (await one("SELECT name FROM quota_groups WHERE id='group-demo'")).name,
      "Production group",
      "seed upserted"
    );
  } finally {
    await pgc.end();
  }

  assert.equal(
    target("conversation_turn_nodes")?.orphansDeleted,
    1,
    "orphan turn deleted (FK-del)"
  );
  assert.deepEqual(source("agentic_conversations")?.droppedColumnValues, {
    last_message_count: 1,
    last_messages_hash: 1,
  });
  assert.equal(source("xp_audit_log")?.disposition, "dropped");
  assert.equal(source("xp_audit_log")?.rows, 1);
  assert.ok(receipt.keyValue.dropped.some((d) => d.namespace === "gamification:streaks"));
  assert.deepEqual(receipt.checks.apiKeyHashes, {
    rows: 1,
    match: 1,
    mismatch: 0,
    unchecked: 0,
    encryptionKeyPresent: false,
  });
});

test("refuses an unknown key_value namespace instead of dropping it", { skip }, async () => {
  const { file, db } = newSourceDb();
  kv(db, "someNewNamespace", "k", '"v"');
  db.close();
  await assert.rejects(
    runTransfer({ sqlitePath: file, targetUrl: await newTargetDb() }),
    /someNewNamespace/
  );
});

test("refuses a target database that is not empty", { skip }, async () => {
  const { file, db } = newSourceDb();
  db.close();
  const targetUrl = await newTargetDb();
  const c = new pg.Client({ connectionString: targetUrl });
  await c.connect();
  await c.query("CREATE TABLE leftover (id int)");
  await c.end();
  await assert.rejects(runTransfer({ sqlitePath: file, targetUrl }), /not empty/);
});

test("refuses a live source (non-empty WAL)", async () => {
  const { file, db } = newSourceDb();
  db.pragma("journal_mode = WAL");
  kv(db, "settings", "x", "1");
  // db stays open: the -wal file holds the uncheckpointed write.
  await assert.rejects(
    runTransfer({ sqlitePath: file, targetUrl: "postgres://unused" }),
    /looks live/
  );
  db.close();
});

test("finds the PostgreSQL migrations by its own location, never the SQLite ones", () => {
  const saved = process.env.OMNIROUTE_PG_MIGRATIONS_DIR;
  delete process.env.OMNIROUTE_PG_MIGRATIONS_DIR;
  try {
    const dir = transferMigrationsDir();
    assert.equal(path.basename(path.dirname(dir)), "postgres");
    assert.ok(fs.existsSync(path.join(dir, "0001_init.sql")), `${dir} holds 0001_init.sql`);
  } finally {
    if (saved !== undefined) process.env.OMNIROUTE_PG_MIGRATIONS_DIR = saved;
  }
});

test("stops when the migrations folder holds no PostgreSQL migrations", { skip }, async () => {
  const { file, db } = newSourceDb();
  db.close();
  const empty = fs.mkdtempSync(path.join(workDir, "no-migrations-"));
  // The SQLite migrations' 3-digit names, which the PostgreSQL runner ignores.
  fs.writeFileSync(path.join(empty, "001_initial_schema.sql"), "SELECT 1;");
  const saved = process.env.OMNIROUTE_PG_MIGRATIONS_DIR;
  process.env.OMNIROUTE_PG_MIGRATIONS_DIR = empty;
  try {
    await assert.rejects(
      runTransfer({ sqlitePath: file, targetUrl: await newTargetDb() }),
      /No PostgreSQL migrations found/
    );
  } finally {
    if (saved === undefined) delete process.env.OMNIROUTE_PG_MIGRATIONS_DIR;
    else process.env.OMNIROUTE_PG_MIGRATIONS_DIR = saved;
  }
});
