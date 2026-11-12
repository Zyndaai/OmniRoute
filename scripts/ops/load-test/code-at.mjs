#!/usr/bin/env node
/**
 * Prints the minified code around a profile frame's position, so the frame can
 * be recognised in source (by its SQL, strings or exported names). Run it where
 * the build lives, e.g. inside the omniroute container:
 *
 *   docker exec -i omniroute node --input-type=module - \
 *     /app/.build/next/server/chunks/707.js 35 11628 < scripts/ops/load-test/code-at.mjs
 *
 * Arguments: file, line, column (1-based, as analyze-profile.mjs prints them),
 * and optionally the number of characters to show on each side (default 200).
 */
import { readFileSync } from "node:fs";

const [file, line, column, span = "200"] = process.argv.slice(2);
if (!file || !line || !column) throw new Error("usage: code-at.mjs <file> <line> <column> [span]");
const lines = readFileSync(file, "utf8").split("\n");
const text = lines[Number(line) - 1] ?? "";
const at = Number(column) - 1;
const width = Number(span);
console.log(`${file} L${line}:C${column} (line length ${text.length}, ${lines.length} lines)`);
console.log(`${text.slice(Math.max(0, at - width), at)}⟦HERE⟧${text.slice(at, at + width)}`);
