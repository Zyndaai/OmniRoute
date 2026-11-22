/**
 * One-way transfer of an OmniRoute SQLite database into a new, empty PostgreSQL database
 * (Stage 7 of the PostgreSQL migration). The contract is
 * `docs/architecture/postgres-schema-mapping.md`; the dispositions are in ./registry.ts and
 * ./keyValue.ts, the value rules in ./convert.ts.
 *
 * Steps:
 *  1. Refuse a live source (non-empty `-wal`) and a non-empty target.
 *  2. Migrate the target, read its catalog and its seed rows.
 *  3. Build every target row in memory (the data is small), resolving orphans by each foreign
 *     key's ON DELETE rule (SET NULL -> null the reference, otherwise delete the child).
 *  4. Load everything in ONE transaction: day partitions, inserts (seed tables upsert), setval.
 *  5. Read every touched table back and compare it, row by row and value by value, with what
 *     the transfer meant to write; record counts, every skip with its reason, and a sha256 of
 *     each table's canonical content in the receipt.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import pg from "pg";

import { decrypt, isEncryptionEnabled, looksEncrypted } from "@/lib/db/encryption";
import { opaqueTokenFingerprint } from "@omniroute/open-sse/utils/opaqueTokenFingerprint.ts";

import { createPostgresBackend } from "../postgres/postgresBackend";
import { runPostgresMigrations } from "../postgres/migrationRunner";
import { loadTargetCatalog, type TargetCatalog, type TargetTable } from "./catalog";
import { convertValue, isProblem, type Problem, type TargetColumn } from "./convert";
import { dispatchKeyValue, type KeyValueRow } from "./keyValue";
import {
  COPY_SPECS,
  DROPPED_TABLES,
  INTERNAL_TABLES,
  SPECIAL_TABLES,
  UNSUPPORTED_WHEN_NONEMPTY,
  type CopySpec,
} from "./registry";

export interface TransferOptions {
  sqlitePath: string;
  targetUrl: string;
  now?: number;
  log?: (line: string) => void;
}

export interface SourceReport {
  table: string;
  rows: number;
  disposition: "copied" | "dropped" | "internal" | "special" | "empty-no-target";
  target?: string;
  reason?: string;
  /** dropped column -> number of non-NULL values it held */
  droppedColumnValues?: Record<string, number>;
}

export interface TargetReport {
  table: string;
  /** rows the source offered this table (copied table, merges, key_value) */
  offered: number;
  /** offered === written + skipped + orphansDeleted: no row vanished without a reason */
  reconciled: boolean;
  written: number;
  seedRows: number;
  /** reason -> rows not written */
  skipped: Record<string, number>;
  /** "<column>: <problem>" -> values resolved (nulled, defaulted, clamped, stripped) */
  adjusted: Record<string, number>;
  orphansDeleted: number;
  orphansNulled: number;
  verified: { expected: number; actual: number; mismatchedRows: number; sha256: string };
  mismatchSamples: string[];
}

export interface TransferReceipt {
  tool: "omniroute-sqlite-to-postgres";
  startedAt: string;
  finishedAt: string;
  source: { path: string; sha256: string; bytes: number; migrations: string | null };
  target: { migrations: string[] };
  /** Every table stores exactly what was meant and every source row is accounted for. */
  ok: boolean;
  /**
   * Skips and adjustments outside the expected kinds (pin dedupe, orphans, planned drops). At
   * the cut-over, compare them with the dry run's receipt: anything new means stop.
   */
  review: string[];
  sources: SourceReport[];
  targets: TargetReport[];
  keyValue: {
    dropped: Array<{ namespace: string; count: number; reason: string }>;
    skipped: Array<{ namespace: string; key: string; reason: string }>;
  };
  effectiveDatabaseSettings: Record<string, Record<string, unknown>>;
  checks: Record<string, unknown>;
}

const DEFAULT = Symbol("DEFAULT");
type Cell = unknown | typeof DEFAULT;
type TargetRow = Map<string, Cell>;

class TransferAbort extends Error {}

/** Skip reasons that are part of the mapping, not a sign of unexpected data. */
const EXPECTED_SKIPS = new Set(["older pin of the same (combo, session)"]);

interface TargetState {
  table: TargetTable;
  offered: number;
  rows: Map<string, TargetRow>;
  seeds: Map<string, TargetRow>;
  skipped: Record<string, number>;
  adjusted: Record<string, number>;
  orphansDeleted: number;
  orphansNulled: number;
}

const bump = (map: Record<string, number>, key: string, by = 1) => {
  map[key] = (map[key] ?? 0) + by;
};

function pkKey(table: TargetTable, row: TargetRow): string {
  const cols = table.primaryKey.length ? table.primaryKey : table.columns.map((c) => c.name);
  return JSON.stringify(cols.map((c) => canonicalCell(table.byName.get(c), row.get(c))));
}

// ---------------------------------------------------------------------------------------------
// Canonical text of a value, used to compare what was meant with what was stored.

function trimDecimal(text: string): string {
  if (!text.includes(".")) return text === "-0" ? "0" : text;
  const trimmed = text.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "-0" ? "0" : trimmed;
}

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as object).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${sortedJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function pgTimestampToIso(text: string): string {
  // Raw timestamptz output in a UTC session: "2026-11-20 10:00:00.123+00".
  const normalized = text.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  return new Date(normalized).toISOString();
}

function parsePgArray(text: string): string[] {
  const inner = text.slice(1, -1);
  if (inner === "") return [];
  return inner.split(",").map((part) => part.replace(/^"|"$/g, ""));
}

/** Canonical form of an intended (bind) value. */
function canonicalCell(column: TargetColumn | undefined, value: Cell): string {
  if (value === DEFAULT) return "<default>";
  if (value === null || value === undefined) return "<null>";
  const udt = column?.udt ?? "text";
  switch (udt) {
    case "jsonb":
    case "json":
      return sortedJson((value as { json: unknown }).json);
    case "numeric":
    case "float4":
    case "float8":
      return trimDecimal(String(value));
    case "bool":
      return value ? "true" : "false";
    case "time":
      return String(value).length === 5 ? `${value}:00` : String(value);
    case "bytea":
      return (value as Buffer).toString("hex");
    case "_timestamptz":
    case "_int2":
    case "_int4":
    case "_int8":
      return JSON.stringify((value as unknown[]).map(String));
    default:
      return String(value);
  }
}

/** Canonical form of a raw text value read back from PostgreSQL. */
function canonicalStored(column: TargetColumn, raw: string | null): string {
  if (raw === null) return "<null>";
  switch (column.udt) {
    case "jsonb":
    case "json":
      return sortedJson(JSON.parse(raw));
    case "timestamptz":
      return pgTimestampToIso(raw);
    case "numeric":
    case "float4":
    case "float8":
      return trimDecimal(raw);
    case "bool":
      return raw === "t" ? "true" : "false";
    case "bytea":
      return raw.startsWith("\\x") ? raw.slice(2) : raw;
    case "_timestamptz":
      return JSON.stringify(parsePgArray(raw).map(pgTimestampToIso));
    case "_int2":
    case "_int4":
    case "_int8":
      return JSON.stringify(parsePgArray(raw));
    default:
      return raw;
  }
}

// ---------------------------------------------------------------------------------------------

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function fileSha256(path: string): string {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(path));
  return hash.digest("hex");
}

function rawTextClient(url: string): pg.Client {
  // Every value comes back as PostgreSQL's text output, so verification sees what is stored,
  // not what a type parser makes of it.
  return new pg.Client({
    connectionString: url,
    types: { getTypeParser: () => (value: string) => value } as unknown as pg.CustomTypesConfig,
  });
}

/**
 * Resolves one converted value for a target row. Returns the cell, or `{ skip }` when the row
 * cannot be written.
 */
function resolveCell(
  state: TargetState,
  column: TargetColumn,
  spec: CopySpec | undefined,
  converted: unknown,
  rowCreatedAt: unknown
): Cell | { skip: string } {
  if (isProblem(converted)) {
    const problem = converted as Problem;
    const label = `${column.name}: ${problem.problem}`;
    if (problem.problem === "not-a-uuid") {
      throw new TransferAbort(
        `${state.table.name}.${column.name} holds a value that is not a UUID`
      );
    }
    if (problem.problem === "not-in-allowed-set") {
      if (spec?.enumToNull?.includes(column.name) && !column.notNull) {
        bump(state.adjusted, `${label} -> null`);
        return null;
      }
      const fallback = spec?.enumFallback?.[column.name];
      if (fallback === undefined) return { skip: `${column.name} outside its CHECK list` };
      bump(state.adjusted, `${label} -> ${fallback}`);
      return fallback;
    }
    if (problem.problem === "invalid-json" && spec?.jsonRawColumns?.includes(column.name)) {
      bump(state.adjusted, `${label} -> kept as a JSON string`);
      return { json: "__RAW__" }; // replaced by the caller with the raw text
    }
    if ("fallback" in problem && problem.fallback !== undefined) {
      bump(state.adjusted, label);
      return problem.fallback;
    }
    bump(state.adjusted, `${label} -> null`);
    converted = null;
  }
  if (converted !== null) return converted;
  if (!column.notNull) return null;
  if (column.hasDefault) return DEFAULT;
  if (column.udt === "timestamptz" && rowCreatedAt) return rowCreatedAt;
  return { skip: `${column.name} is NOT NULL and has no value` };
}

function buildRow(
  state: TargetState,
  source: Record<string, unknown>,
  spec: CopySpec | undefined
): TargetRow | { skip: string } {
  const row: TargetRow = new Map();
  // created_at first, so a NOT NULL timestamp without a value can fall back to it.
  const createdColumn = state.table.byName.get("created_at");
  let createdAt: unknown = null;
  if (createdColumn && createdColumn.udt === "timestamptz") {
    const c = convertValue(source.created_at, createdColumn);
    if (!isProblem(c)) createdAt = c;
  }
  for (const column of state.table.columns) {
    if (!(column.name in source)) {
      if (column.notNull && !column.hasDefault) {
        return { skip: `${column.name} is NOT NULL and missing from the source` };
      }
      row.set(column.name, column.hasDefault ? DEFAULT : null);
      continue;
    }
    const raw = source[column.name];
    const converted = convertValue(raw, column);
    const cell = resolveCell(state, column, spec, converted, createdAt);
    if (cell && typeof cell === "object" && "skip" in (cell as object))
      return cell as { skip: string };
    if (cell && typeof cell === "object" && (cell as { json?: unknown }).json === "__RAW__") {
      row.set(column.name, { json: String(raw) });
    } else {
      row.set(column.name, cell);
    }
  }
  return row;
}

function addRow(state: TargetState, row: TargetRow, duplicateReason: string): void {
  const key = pkKey(state.table, row);
  if (state.rows.has(key)) {
    bump(state.skipped, duplicateReason);
    return;
  }
  state.rows.set(key, row);
}

// ---------------------------------------------------------------------------------------------

export async function runTransfer(options: TransferOptions): Promise<TransferReceipt> {
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now();
  const startedAt = new Date().toISOString();

  const wal = `${options.sqlitePath}-wal`;
  if (fs.existsSync(wal) && fs.statSync(wal).size > 0) {
    throw new TransferAbort(
      `${wal} is not empty: the source looks live. Stop the app (or transfer a backup snapshot).`
    );
  }
  const sourceSha = fileSha256(options.sqlitePath);

  const admin = new pg.Client({ connectionString: options.targetUrl });
  await admin.connect();
  try {
    const { rows: existing } = await admin.query(
      "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'"
    );
    if (existing[0].n !== 0) {
      throw new TransferAbort(
        "The target database is not empty. Create a new database (LC_COLLATE 'C', TEMPLATE template0)."
      );
    }
  } finally {
    await admin.end();
  }

  const pool = new pg.Pool({ connectionString: options.targetUrl, max: 2 });
  const migrated = await runPostgresMigrations(createPostgresBackend(pool), {
    logger: { info: (line: string) => log(line) },
  });
  await pool.end();
  log(`[transfer] target migrated: ${migrated.applied.join(", ")}`);

  // Read a private copy: a WAL-mode file (a backup-API snapshot keeps the flag) needs a -shm
  // file beside it even for a read-only connection, and the source folder may not be writable.
  // The copy is switched to rollback journaling, so reading it never touches the original.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-transfer-"));
  const workCopy = path.join(workDir, "source.sqlite");
  fs.copyFileSync(options.sqlitePath, workCopy);
  const sqlite = new Database(workCopy, { fileMustExist: true });
  sqlite.pragma("journal_mode = DELETE");
  const client = rawTextClient(options.targetUrl);
  try {
    await client.connect();
    await client.query("SET TimeZone = 'UTC'");
    const catalog = await loadTargetCatalog(client);
    const states = new Map<string, TargetState>();
    const stateFor = (name: string): TargetState => {
      let state = states.get(name);
      if (!state) {
        const table = catalog.tables.get(name);
        if (!table) throw new TransferAbort(`no target table ${name}`);
        state = {
          table,
          rows: new Map(),
          seeds: new Map(),
          skipped: {},
          adjusted: {},
          orphansDeleted: 0,
          orphansNulled: 0,
          offered: 0,
        };
        states.set(name, state);
      }
      return state;
    };

    // Seed rows the migrations created; seeded tables upsert over them.
    for (const table of catalog.tables.values()) {
      if (table.name === "_omniroute_migrations") continue;
      const { rows } = await client.query(`SELECT * FROM ${quoteIdent(table.name)}`);
      if (rows.length === 0) continue;
      const state = stateFor(table.name);
      for (const raw of rows) {
        const row: TargetRow = new Map();
        for (const column of table.columns)
          row.set(column.name, storedToCell(column, raw[column.name] as string | null));
        state.seeds.set(pkKey(table, row), row);
      }
    }

    const sources: SourceReport[] = [];
    const sourceTables = sqlite
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string; sql: string | null }>;
    const countRows = (name: string): number | null => {
      try {
        return (
          sqlite.prepare(`SELECT count(*) AS n FROM ${quoteIdent(name)}`).get() as { n: number }
        ).n;
      } catch {
        return null;
      }
    };
    const readRows = (name: string): Array<Record<string, unknown>> => {
      try {
        return sqlite.prepare(`SELECT rowid AS __rowid, * FROM ${quoteIdent(name)}`).all() as Array<
          Record<string, unknown>
        >;
      } catch {
        return sqlite.prepare(`SELECT * FROM ${quoteIdent(name)}`).all() as Array<
          Record<string, unknown>
        >;
      }
    };

    const connectionIds = new Set<string>();
    const special = new Map<string, Array<Record<string, unknown>>>();

    for (const { name } of sourceTables) {
      const count = countRows(name);
      if (INTERNAL_TABLES.has(name) || name.startsWith("sqlite_")) {
        sources.push({ table: name, rows: count ?? 0, disposition: "internal" });
        continue;
      }
      if (DROPPED_TABLES[name] || name.startsWith("memory_fts")) {
        sources.push({
          table: name,
          rows: count ?? 0,
          disposition: "dropped",
          reason: DROPPED_TABLES[name] ?? "memory engine removed",
        });
        continue;
      }
      if (count === null) throw new TransferAbort(`cannot read source table ${name}`);
      if (SPECIAL_TABLES.has(name)) {
        special.set(name, readRows(name));
        sources.push({ table: name, rows: count, disposition: "special" });
        continue;
      }
      if (UNSUPPORTED_WHEN_NONEMPTY[name]) {
        if (count > 0) {
          throw new TransferAbort(
            `${name} holds ${count} rows; its ${UNSUPPORTED_WHEN_NONEMPTY[name]} is not implemented`
          );
        }
        sources.push({
          table: name,
          rows: 0,
          disposition: "empty-no-target",
          reason: UNSUPPORTED_WHEN_NONEMPTY[name],
        });
        continue;
      }
      const table = catalog.tables.get(name);
      if (!table) {
        if (count > 0)
          throw new TransferAbort(`${name} holds ${count} rows and has no disposition`);
        sources.push({ table: name, rows: 0, disposition: "empty-no-target" });
        continue;
      }

      const spec = COPY_SPECS[name];
      const state = stateFor(name);
      const report: SourceReport = {
        table: name,
        rows: count,
        disposition: "copied",
        target: name,
      };
      const droppedValues: Record<string, number> = {};
      const unmapped: Record<string, number> = {};
      const sourceRows = readRows(name);
      if (sourceRows.length !== count) {
        throw new TransferAbort(`${name}: counted ${count} rows but read ${sourceRows.length}`);
      }
      state.offered += sourceRows.length;
      for (const original of sourceRows) {
        let row: Record<string, unknown> = { ...original };
        const rowid = row.__rowid;
        delete row.__rowid;
        if (spec?.rewrite) {
          const rewritten = spec.rewrite(row);
          if ("skip" in rewritten && typeof rewritten.skip === "string") {
            bump(state.skipped, rewritten.skip);
            continue;
          }
          row = rewritten as Record<string, unknown>;
        }
        const mapped: Record<string, unknown> = {};
        for (const [column, value] of Object.entries(row)) {
          if (spec?.dropColumns?.includes(column)) {
            if (value !== null && value !== undefined) bump(droppedValues, column);
            continue;
          }
          const target = spec?.rename?.[column] ?? column;
          if (!table.byName.has(target)) {
            if (value !== null && value !== undefined && value !== "") bump(unmapped, column);
            continue;
          }
          mapped[target] = value;
        }
        if (spec?.seqFromRowid) mapped[spec.seqFromRowid] = rowid;
        const built = buildRow(state, mapped, spec);
        if ("skip" in built) {
          bump(state.skipped, (built as { skip: string }).skip);
          continue;
        }
        addRow(state, built as TargetRow, "duplicate primary key in the source");
        if (name === "provider_connections" && typeof mapped.id === "string")
          connectionIds.add(mapped.id);
      }
      if (Object.keys(unmapped).length > 0) {
        throw new TransferAbort(
          `${name}: source columns with values but no target column: ${JSON.stringify(unmapped)}`
        );
      }
      if (Object.keys(droppedValues).length > 0) report.droppedColumnValues = droppedValues;
      sources.push(report);
    }

    // session_model_history -> session_model_pins: the latest row per (combo_name, session_id).
    const history = special.get("session_model_history") ?? [];
    const latest = new Map<string, Record<string, unknown>>();
    for (const row of history) {
      const key = `${row.combo_name}\u0000${row.session_id}`;
      const seen = latest.get(key);
      const newer =
        !seen ||
        String(row.used_at) > String(seen.used_at) ||
        (String(row.used_at) === String(seen.used_at) && Number(row.id) > Number(seen.id));
      if (newer) latest.set(key, row);
    }
    if (history.length > 0) {
      const state = stateFor("session_model_pins");
      state.offered += history.length;
      bump(state.skipped, "older pin of the same (combo, session)", history.length - latest.size);
      for (const row of latest.values()) {
        const { id: _id, __rowid: _rowid, ...rest } = row;
        const built = buildRow(state, rest, undefined);
        if ("skip" in built) bump(state.skipped, (built as { skip: string }).skip);
        else addRow(state, built as TargetRow, "duplicate primary key");
      }
    }

    // api_key_quota_counters + quota_consumption -> quota_counters (disjoint key spaces).
    for (const name of ["quota_consumption", "api_key_quota_counters"]) {
      const rows = special.get(name) ?? [];
      if (rows.length === 0) continue;
      const state = stateFor("quota_counters");
      state.offered += rows.length;
      for (const row of rows) {
        const { __rowid: _rowid, ...rest } = row;
        const built = buildRow(state, rest, undefined);
        if ("skip" in built) bump(state.skipped, (built as { skip: string }).skip);
        else addRow(state, built as TargetRow, `duplicate key across ${name}`);
      }
    }

    // key_value -> config_entries and the catalog tables. Copied tables were loaded first, so
    // their rows win over key_value duplicates (agent_bridge_mappings vs mitmAlias).
    const kvRows = (special.get("key_value") ?? []).map((r) => ({
      namespace: String(r.namespace),
      key: String(r.key),
      value: String(r.value),
    })) as KeyValueRow[];
    const kv = dispatchKeyValue(kvRows, { now, connectionIds });
    for (const { table, row } of kv.rows) {
      const state = stateFor(table);
      state.offered++;
      const built = buildRow(state, row, COPY_SPECS[table]);
      if ("skip" in built) bump(state.skipped, (built as { skip: string }).skip);
      else addRow(state, built as TargetRow, "key_value duplicate of a copied row");
    }

    resolveOrphans(catalog, states);

    // ---- load, in one transaction --------------------------------------------------------
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL statement_timeout = 0");
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      for (const state of states.values()) {
        if (!state.table.partitioned || state.rows.size === 0) continue;
        const days = [...state.rows.values()]
          .map((r) => r.get("timestamp"))
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.slice(0, 10))
          .sort();
        if (days.length === 0) continue;
        await client.query("SELECT omniroute_ensure_daily_partitions($1, $2::date, $3::date)", [
          state.table.name,
          days[0],
          days[days.length - 1],
        ]);
      }
      for (const state of states.values()) {
        if (state.rows.size === 0) continue;
        await insertRows(client, state, COPY_SPECS[state.table.name]?.upsertSeeds === true);
      }
      for (const state of states.values()) {
        for (const column of state.table.columns.filter((c) => c.identity)) {
          await client.query(
            `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE(max(${quoteIdent(column.name)}), 0) + 1, false)
               FROM ${quoteIdent(state.table.name)}`,
            [state.table.name, column.name]
          );
        }
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
    await client.query("ANALYZE");

    // ---- verify ---------------------------------------------------------------------------
    const targets: TargetReport[] = [];
    for (const state of [...states.values()].sort((a, b) =>
      a.table.name.localeCompare(b.table.name)
    )) {
      targets.push(await verifyTable(client, state));
    }
    const checks = await runChecks(client, states);

    const receipt: TransferReceipt = {
      tool: "omniroute-sqlite-to-postgres",
      startedAt,
      finishedAt: new Date().toISOString(),
      source: {
        path: options.sqlitePath,
        sha256: sourceSha,
        bytes: fs.statSync(options.sqlitePath).size,
        migrations: (() => {
          try {
            const r = sqlite
              .prepare("SELECT max(CAST(version AS INTEGER)) AS v FROM _omniroute_migrations")
              .get() as { v: number | null };
            return r.v === null ? null : String(r.v);
          } catch {
            return null;
          }
        })(),
      },
      target: { migrations: migrated.applied },
      ok: targets.every(
        (t) =>
          t.reconciled &&
          t.verified.mismatchedRows === 0 &&
          t.verified.expected === t.verified.actual
      ),
      review: [
        ...targets.flatMap((t) => [
          ...Object.entries(t.skipped)
            .filter(([reason]) => !EXPECTED_SKIPS.has(reason))
            .map(([reason, n]) => `${t.table}: ${n} row(s) skipped: ${reason}`),
          ...Object.entries(t.adjusted).map(([what, n]) => `${t.table}: ${n} value(s) ${what}`),
          ...(t.reconciled ? [] : [`${t.table}: rows unaccounted for`]),
        ]),
        ...kv.skipped.map((s) => `key_value ${s.namespace} "${s.key}" skipped: ${s.reason}`),
      ],
      sources,
      targets,
      keyValue: { dropped: kv.dropped, skipped: kv.skipped },
      effectiveDatabaseSettings: kv.effectiveDatabaseSettings,
      checks,
    };
    return receipt;
  } finally {
    await client.end().catch(() => {});
    sqlite.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/** A seed row read back as raw text, in bind-value form (so it canonicalizes like the rest). */
function storedToCell(column: TargetColumn, raw: string | null): Cell {
  if (raw === null) return null;
  switch (column.udt) {
    case "jsonb":
    case "json":
      return { json: JSON.parse(raw) };
    case "bool":
      return raw === "t";
    case "timestamptz":
      return pgTimestampToIso(raw);
    case "bytea":
      return Buffer.from(raw.slice(2), "hex");
    case "_timestamptz":
      return parsePgArray(raw).map(pgTimestampToIso);
    case "_int2":
    case "_int4":
    case "_int8":
      return parsePgArray(raw).map(Number);
    default:
      return raw;
  }
}

/** Deletes or nulls child rows whose parent is missing, until nothing changes. */
function resolveOrphans(catalog: TargetCatalog, states: Map<string, TargetState>): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const fk of catalog.foreignKeys) {
      const child = states.get(fk.table);
      if (!child || child.rows.size === 0) continue;
      const parent = states.get(fk.refTable);
      const parentTable = catalog.tables.get(fk.refTable);
      if (!parentTable) continue;
      const parentKeys = new Set<string>();
      for (const rows of [parent?.rows, parent?.seeds]) {
        for (const row of rows?.values() ?? []) {
          parentKeys.add(
            JSON.stringify(
              fk.refColumns.map((c) => canonicalCell(parentTable.byName.get(c), row.get(c)))
            )
          );
        }
      }
      for (const [key, row] of child.rows) {
        const values = fk.columns.map((c) => row.get(c));
        if (values.some((v) => v === null || v === undefined || v === DEFAULT)) continue;
        const ref = JSON.stringify(
          fk.columns.map((c, i) =>
            canonicalCell(parentTable.byName.get(fk.refColumns[i]), row.get(c))
          )
        );
        if (parentKeys.has(ref)) continue;
        if (fk.onDelete === "n") {
          for (const c of fk.columns) row.set(c, null);
          child.orphansNulled++;
        } else {
          child.rows.delete(key);
          child.orphansDeleted++;
        }
        changed = true;
      }
    }
  }
}

async function insertRows(client: pg.Client, state: TargetState, upsert: boolean): Promise<void> {
  const columns = state.table.columns;
  const columnList = columns.map((c) => quoteIdent(c.name)).join(", ");
  const conflict = upsert
    ? ` ON CONFLICT (${state.table.primaryKey.map(quoteIdent).join(", ")}) DO UPDATE SET ${columns
        .filter((c) => !state.table.primaryKey.includes(c.name))
        .map((c) => `${quoteIdent(c.name)} = EXCLUDED.${quoteIdent(c.name)}`)
        .join(", ")}`
    : "";
  const rows = [...state.rows.values()];
  const perBatch = Math.max(1, Math.floor(30_000 / columns.length));
  for (let start = 0; start < rows.length; start += perBatch) {
    const batch = rows.slice(start, start + perBatch);
    const params: unknown[] = [];
    const tuples = batch.map((row) => {
      const cells = columns.map((column) => {
        const cell = row.get(column.name);
        if (cell === DEFAULT) return "DEFAULT";
        if (cell && typeof cell === "object" && "json" in (cell as object)) {
          params.push(JSON.stringify((cell as { json: unknown }).json));
        } else {
          params.push(cell === undefined ? null : cell);
        }
        return `$${params.length}`;
      });
      return `(${cells.join(", ")})`;
    });
    await client.query(
      `INSERT INTO ${quoteIdent(state.table.name)} (${columnList}) VALUES ${tuples.join(", ")}${conflict}`,
      params
    );
  }
}

async function verifyTable(client: pg.Client, state: TargetState): Promise<TargetReport> {
  const { table } = state;
  const expected = new Map(state.seeds);
  for (const [key, row] of state.rows) expected.set(key, row);

  const { rows } = await client.query(`SELECT * FROM ${quoteIdent(table.name)}`);
  const actual = new Map<string, Record<string, string | null>>();
  for (const raw of rows as Array<Record<string, string | null>>) {
    const key = JSON.stringify(
      (table.primaryKey.length ? table.primaryKey : table.columns.map((c) => c.name)).map((c) =>
        canonicalStored(table.byName.get(c)!, raw[c])
      )
    );
    actual.set(key, raw);
  }

  let mismatched = 0;
  const samples: string[] = [];
  const hash = createHash("sha256");
  for (const key of [...actual.keys()].sort()) {
    const stored = actual.get(key)!;
    const canonical = table.columns.map((c) => canonicalStored(c, stored[c.name]));
    hash.update(`${JSON.stringify(canonical)}\n`);
    const want = expected.get(key);
    if (!want) {
      mismatched++;
      if (samples.length < 5) samples.push(`unexpected row ${key}`);
      continue;
    }
    for (let i = 0; i < table.columns.length; i++) {
      const column = table.columns[i];
      const intended = want.get(column.name);
      if (intended === DEFAULT) continue; // filled by the database
      const intendedText = canonicalCell(column, intended);
      if (intendedText !== canonical[i]) {
        mismatched++;
        if (samples.length < 5) {
          samples.push(
            `${key} ${column.name}: meant ${intendedText.slice(0, 80)}, stored ${canonical[i].slice(0, 80)}`
          );
        }
        break;
      }
    }
  }
  for (const key of expected.keys()) {
    if (!actual.has(key)) {
      mismatched++;
      if (samples.length < 5) samples.push(`missing row ${key}`);
    }
  }

  const skippedTotal = Object.values(state.skipped).reduce((a, b) => a + b, 0);
  return {
    table: table.name,
    offered: state.offered,
    reconciled: state.offered === state.rows.size + skippedTotal + state.orphansDeleted,
    written: state.rows.size,
    seedRows: state.seeds.size,
    skipped: state.skipped,
    adjusted: state.adjusted,
    orphansDeleted: state.orphansDeleted,
    orphansNulled: state.orphansNulled,
    verified: {
      expected: expected.size,
      actual: actual.size,
      mismatchedRows: mismatched,
      sha256: hash.digest("hex"),
    },
    mismatchSamples: samples,
  };
}

/** Checks that need the app's keys: API key hashes and credential decryption. */
async function runChecks(
  client: pg.Client,
  states: Map<string, TargetState>
): Promise<Record<string, unknown>> {
  const checks: Record<string, unknown> = {};
  const keyRows = (await client.query("SELECT id, key, key_hash FROM api_keys")).rows as Array<
    Record<string, string | null>
  >;
  const encryption = isEncryptionEnabled();
  let hashOk = 0;
  let hashBad = 0;
  let hashUnchecked = 0;
  for (const row of keyRows) {
    const raw = looksEncrypted(row.key)
      ? encryption
        ? decrypt(row.key, { quiet: true })
        : null
      : row.key;
    if (typeof raw !== "string" || raw === "") {
      hashUnchecked++;
      continue;
    }
    if (opaqueTokenFingerprint(raw) === row.key_hash) hashOk++;
    else hashBad++;
  }
  checks.apiKeyHashes = {
    rows: keyRows.length,
    match: hashOk,
    mismatch: hashBad,
    unchecked: hashUnchecked,
    encryptionKeyPresent: encryption,
  };

  const credentialColumns = ["api_key", "access_token", "refresh_token", "id_token"];
  const connRows = states.has("provider_connections")
    ? ((await client.query(`SELECT ${credentialColumns.join(", ")} FROM provider_connections`))
        .rows as Array<Record<string, string | null>>)
    : [];
  let decrypted = 0;
  let failed = 0;
  let plaintext = 0;
  for (const row of connRows) {
    for (const column of credentialColumns) {
      const value = row[column];
      if (!value) continue;
      if (!looksEncrypted(value)) {
        plaintext++;
        continue;
      }
      if (!encryption) continue;
      const out = decrypt(value, { quiet: true });
      if (typeof out === "string" && out.length > 0) decrypted++;
      else failed++;
    }
  }
  checks.providerCredentials = { decrypted, failed, plaintext, checked: encryption };
  return checks;
}
