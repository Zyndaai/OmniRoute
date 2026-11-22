/**
 * The target schema as the transfer needs it, read from PostgreSQL's own catalog after the
 * migrations ran: columns with their types, defaults and fixed-value CHECKs, primary keys,
 * foreign keys (with their ON DELETE action, which decides the orphan rule), partitioned
 * parents.
 */
import type { TargetColumn } from "./convert";

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface ForeignKey {
  name: string;
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  /** a = no action, r = restrict, c = cascade, n = set null, d = set default */
  onDelete: "a" | "r" | "c" | "n" | "d";
}

export interface TargetTable {
  name: string;
  columns: TargetColumn[];
  byName: Map<string, TargetColumn>;
  primaryKey: string[];
  partitioned: boolean;
}

export interface TargetCatalog {
  tables: Map<string, TargetTable>;
  foreignKeys: ForeignKey[];
}

// `CHECK ((status = ANY (ARRAY['a'::text, 'b'::text])))` or `CHECK ((kind = 'x'::text))`.
const ANY_ARRAY =
  /^CHECK \(\(\(?"?(\w+)"?\)?(?:::text)? = ANY \(\(?ARRAY\[(.+)\]\)?(?:::text\[\])?\)\)\)$/;
const LITERAL = /'((?:[^']|'')*)'/g;

/** Fixed value lists from `col = ANY (ARRAY[...])` CHECKs, keyed by column. Others are ignored. */
export function parseEnumCheck(definition: string): { column: string; values: string[] } | null {
  const match = ANY_ARRAY.exec(definition.trim());
  if (!match) return null;
  const values = [...match[2].matchAll(LITERAL)].map((m) => m[1].replaceAll("''", "'"));
  return values.length > 0 ? { column: match[1], values } : null;
}

export async function loadTargetCatalog(client: Queryable): Promise<TargetCatalog> {
  const { rows: columnRows } = await client.query(
    `SELECT c.table_name, c.column_name, c.udt_name, c.is_nullable, c.column_default,
            c.is_identity, c.is_generated, c.numeric_scale
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND NOT EXISTS (SELECT 1 FROM pg_inherits i JOIN pg_class k ON k.oid = i.inhrelid
                         WHERE k.relname = c.table_name)
      ORDER BY c.table_name, c.ordinal_position`
  );
  const { rows: pkRows } = await client.query(
    `SELECT cl.relname AS table_name, a.attname AS column_name, k.ord
       FROM pg_constraint con
       JOIN pg_class cl ON cl.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = cl.relnamespace AND ns.nspname = 'public'
       CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum = k.attnum
      WHERE con.contype = 'p' AND NOT cl.relispartition
      ORDER BY cl.relname, k.ord`
  );
  const { rows: checkRows } = await client.query(
    `SELECT cl.relname AS table_name, pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con
       JOIN pg_class cl ON cl.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = cl.relnamespace AND ns.nspname = 'public'
      WHERE con.contype = 'c' AND NOT cl.relispartition`
  );
  const { rows: fkRows } = await client.query(
    `SELECT con.conname, cl.relname AS table_name, rcl.relname AS ref_table,
            con.confdeltype AS on_delete,
            array_to_string(ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, o)
                    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n
                   ORDER BY k.o), ',') AS columns,
            array_to_string(ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(n, o)
                    JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n
                   ORDER BY k.o), ',') AS ref_columns
       FROM pg_constraint con
       JOIN pg_class cl ON cl.oid = con.conrelid
       JOIN pg_class rcl ON rcl.oid = con.confrelid
       JOIN pg_namespace ns ON ns.oid = cl.relnamespace AND ns.nspname = 'public'
      WHERE con.contype = 'f' AND NOT cl.relispartition`
  );
  const { rows: partRows } = await client.query(
    `SELECT cl.relname AS table_name FROM pg_partitioned_table p
       JOIN pg_class cl ON cl.oid = p.partrelid`
  );

  const allowedByTable = new Map<string, Map<string, Set<string>>>();
  for (const row of checkRows) {
    const parsed = parseEnumCheck(String(row.def));
    if (!parsed) continue;
    const table = String(row.table_name);
    const map = allowedByTable.get(table) ?? new Map<string, Set<string>>();
    map.set(parsed.column, new Set(parsed.values));
    allowedByTable.set(table, map);
  }

  const partitioned = new Set(partRows.map((r) => String(r.table_name)));
  const tables = new Map<string, TargetTable>();
  for (const row of columnRows) {
    if (row.is_generated === "ALWAYS") continue;
    const name = String(row.table_name);
    let table = tables.get(name);
    if (!table) {
      table = {
        name,
        columns: [],
        byName: new Map(),
        primaryKey: [],
        partitioned: partitioned.has(name),
      };
      tables.set(name, table);
    }
    const identity = row.is_identity === "YES";
    const column: TargetColumn = {
      name: String(row.column_name),
      udt: String(row.udt_name),
      notNull: row.is_nullable === "NO",
      hasDefault: identity || row.column_default !== null,
      identity,
      numericScale: row.numeric_scale === null ? null : Number(row.numeric_scale),
      allowed: allowedByTable.get(name)?.get(String(row.column_name)) ?? null,
    };
    table.columns.push(column);
    table.byName.set(column.name, column);
  }
  for (const row of pkRows)
    tables.get(String(row.table_name))?.primaryKey.push(String(row.column_name));

  const foreignKeys: ForeignKey[] = fkRows.map((row) => ({
    name: String(row.conname),
    table: String(row.table_name),
    columns: String(row.columns).split(","),
    refTable: String(row.ref_table),
    refColumns: String(row.ref_columns).split(","),
    onDelete: String(row.on_delete) as ForeignKey["onDelete"],
  }));
  return { tables, foreignKeys };
}
