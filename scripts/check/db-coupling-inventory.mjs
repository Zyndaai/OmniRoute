#!/usr/bin/env node
// scripts/check/db-coupling-inventory.mjs
//
// Markdown inventory of how much of src/ and open-sse/ depends on the SQLite schema and
// on SQLite-specific SQL. It is line- and regex-based: it reads text, it does not parse SQL
// or TypeScript. Treat the numbers as an approximation that can over-count (a table name
// that is also a variable) and miss (a SQL statement whose keyword sits on another line).
//
// Usage: node scripts/check/db-coupling-inventory.mjs > coupling.md
// Context: docs/architecture/persistence-shared-state.md (Inventory section)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCAN_DIRS = ["src", "open-sse"];
const MIGRATIONS_DIR = path.join(ROOT, "src/lib/db/migrations");
const CORE_FILE = path.join(ROOT, "src/lib/db/core.ts");
const SKIP_DIRS = new Set(["node_modules", ".next", "dist"]);
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const TEST_PATH = /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:__tests__|__mocks__|__snapshots__)\//;
const CREATE_TABLE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z_]\w*)/gi;
const SQL_KEYWORD = /\b(?:SELECT|INSERT|UPDATE|DELETE|FROM|JOIN|INTO)\b/i;
const CODE_IMPORT = /^\s*(?:import|export)\b|\brequire\(/;
const IMPORT_FROM = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
const CORE_SPECIFIER = /(?:^|\/)core(?:\.[cm]?[jt]s)?$/;
const JOIN = /\bJOIN\b/;

const CONSTRUCTS = [
  ["prepare", /\.prepare\(/g],
  ["transaction", /\.transaction\(/g],
  ["immediate", /\.immediate\(/g],
  ["INSERT OR REPLACE", /INSERT\s+OR\s+REPLACE/gi],
  ["INSERT OR IGNORE", /INSERT\s+OR\s+IGNORE/gi],
  ["ON CONFLICT", /ON\s+CONFLICT/gi],
  ["strftime(", /strftime\(/gi],
  ["json_extract(", /json_extract\(/gi],
  ["datetime(", /\bdatetime\(/gi],
  ["lastInsertRowid", /lastInsertRowid/g],
  ["sqlite_master", /sqlite_master/g],
  ["PRAGMA", /\bPRAGMA\b/g],
  ["COLLATE NOCASE", /COLLATE\s+NOCASE/gi],
];

function toPosix(absolute) {
  return path.relative(ROOT, absolute).split(path.sep).join("/");
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else if (SOURCE_FILE.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function isCommentLine(line) {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("--")
  );
}

function createdTables(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !isCommentLine(line))
    .flatMap((line) => [...line.matchAll(CREATE_TABLE)].map((match) => match[1]));
}

function loadTables() {
  const tables = new Set();
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"))) {
    for (const name of createdTables(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"))) {
      tables.add(name);
    }
  }
  for (const name of createdTables(fs.readFileSync(CORE_FILE, "utf8"))) tables.add(name);
  return [...tables].sort();
}

function loadSourceFiles() {
  return SCAN_DIRS.flatMap((dir) => walk(path.join(ROOT, dir), []))
    .map(toPosix)
    .filter((rel) => !TEST_PATH.test(rel))
    .sort()
    .map((rel) => ({ rel, text: fs.readFileSync(path.join(ROOT, rel), "utf8") }));
}

function sqlLinesOf(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !isCommentLine(line) && !CODE_IMPORT.test(line) && SQL_KEYWORD.test(line));
}

function tableSection(tables, files) {
  const sqlLines = new Map(files.map(({ rel, text }) => [rel, sqlLinesOf(text)]));
  const lines = ["## a. Tables and the source files that run SQL against them", ""];
  lines.push(
    "Heuristic: a non-comment, non-import line that contains the table name as a whole word and",
    "an SQL keyword (SELECT, INSERT, UPDATE, DELETE, FROM, JOIN, INTO). Statements whose keyword",
    "sits on a different line from the table name are missed.",
    ""
  );
  for (const table of tables) {
    const pattern = new RegExp(`\\b${table}\\b`);
    const matches = files
      .map(({ rel }) => rel)
      .filter((rel) => sqlLines.get(rel).some((line) => pattern.test(line)));
    lines.push(`### \`${table}\` (${matches.length} files)`);
    if (matches.length === 0) lines.push("- none");
    for (const rel of matches) lines.push(`- ${rel}`);
    lines.push("");
  }
  return lines;
}

function constructSection(constructRows) {
  const header = `| file | ${CONSTRUCTS.map(([label]) => label).join(" | ")} |`;
  const divider = `| --- | ${CONSTRUCTS.map(() => "---:").join(" | ")} |`;
  return [
    "## b. SQLite constructs per file (files with at least one match)",
    "",
    header,
    divider,
    ...constructRows.map(({ rel, counts }) => `| ${rel} | ${counts.join(" | ")} |`),
    "",
  ];
}

function importerSection(importers) {
  return [
    "## c. Files importing getDbInstance",
    "",
    "| file | module specifier | direct core import |",
    "| --- | --- | --- |",
    ...importers.map(
      ({ rel, spec, core }) => `| ${rel} | \`${spec}\` | ${core ? "yes" : "no"} |`
    ),
    "",
  ];
}

function joinSection(joinLines) {
  return ["## d. Lines containing JOIN", "", ...joinLines.map((entry) => `- ${entry}`), ""];
}

function main() {
  const tables = loadTables();
  const files = loadSourceFiles();

  const constructRows = files
    .map(({ rel, text }) => ({
      rel,
      counts: CONSTRUCTS.map(([, pattern]) => (text.match(pattern) ?? []).length),
    }))
    .filter((row) => row.counts.some((count) => count > 0));

  const importers = [];
  for (const { rel, text } of files) {
    for (const [, names, spec] of text.matchAll(IMPORT_FROM)) {
      if (/\bgetDbInstance\b/.test(names)) {
        importers.push({ rel, spec, core: CORE_SPECIFIER.test(spec) });
      }
    }
  }

  const joinLines = [];
  for (const { rel, text } of files) {
    text.split(/\r?\n/).forEach((line, index) => {
      if (JOIN.test(line)) joinLines.push(`${rel}:${index + 1}`);
    });
  }

  const prepareRows = constructRows.filter((row) => row.counts[0] > 0);
  const prepareTotal = prepareRows.reduce((sum, row) => sum + row.counts[0], 0);
  const importerFiles = new Set(importers.map((item) => item.rel));
  const coreImporterFiles = new Set(importers.filter((item) => item.core).map((item) => item.rel));
  const joinFiles = new Set(joinLines.map((entry) => entry.split(":")[0]));

  const out = [
    "# SQLite coupling inventory",
    "",
    "Generated by `scripts/check/db-coupling-inventory.mjs` from `src/` and `open-sse/` (test files excluded).",
    "",
    "## Headline",
    "",
    `- Tables (CREATE TABLE in migrations and core.ts): ${tables.length}`,
    `- Source files scanned: ${files.length}`,
    `- Files containing \`.prepare(\`: ${prepareRows.length} (${prepareTotal} occurrences)`,
    `- Files importing getDbInstance: ${importerFiles.size} (${coreImporterFiles.size} from a core module)`,
    `- Lines containing JOIN: ${joinLines.length} in ${joinFiles.size} files`,
    "",
    ...tableSection(tables, files),
    ...constructSection(constructRows),
    ...importerSection(importers),
    ...joinSection(joinLines),
  ];

  process.stdout.write(`${out.join("\n")}\n`);
}

main();
