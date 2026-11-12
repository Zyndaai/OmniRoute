#!/usr/bin/env node
/**
 * Summarises a .cpuprofile: share of CPU per area (idle, GC, Node internals,
 * Next.js, OmniRoute code, dependencies) and the top functions by self and
 * inclusive time.
 *
 *   node scripts/ops/load-test/analyze-profile.mjs <file.cpuprofile> [topN]
 *
 * Production frames point into minified build chunks (file, line, column); the
 * runbook (docs/ops/LOAD_TESTING.md) says how to map them back to source.
 */
import { readFileSync } from "node:fs";

const profile = JSON.parse(readFileSync(process.argv[2], "utf8"));
const topN = Number(process.argv[3] || 30);
const byId = new Map(profile.nodes.map((node) => [node.id, node]));
const parent = new Map();
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);

// Sample weight = time delta to the next sample (microseconds).
const self = new Map();
profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i + 1] ?? profile.timeDeltas[i] ?? 0)));
const total = [...self.values()].reduce((a, b) => a + b, 0);

function area(frame) {
  const fn = frame.functionName;
  const url = frame.url || "";
  if (fn === "(idle)") return "idle";
  if (fn === "(garbage collector)") return "garbage collection";
  if (fn === "(program)" || fn === "(root)") return "V8 / native";
  if (url.startsWith("node:")) return "Node internals";
  if (/next\/dist|\/\.next\/server\/(chunks\/)?(ssr\/)?\[?turbopack|next-server/.test(url)) return "Next.js runtime";
  if (/node_modules/.test(url)) return "dependencies";
  if (url) return "OmniRoute code (bundled)";
  return "V8 / native";
}

const label = (frame) => {
  const file = (frame.url || "").split(/[\\/]/).slice(-2).join("/");
  return `${frame.functionName || "(anonymous)"} ${file ? `[${file}:${frame.lineNumber + 1}:${frame.columnNumber + 1}]` : ""}`.trim();
};

const areas = new Map();
for (const [id, us] of self) {
  const key = area(byId.get(id).callFrame);
  areas.set(key, (areas.get(key) ?? 0) + us);
}
const pct = (us) => `${((100 * us) / total).toFixed(1)}%`.padStart(6);
console.log(`profile: ${(total / 1e6).toFixed(1)} s sampled`);
console.log("\n== CPU by area (self time)");
for (const [key, us] of [...areas].sort((a, b) => b[1] - a[1])) console.log(`${pct(us)}  ${key}`);

const selfByLabel = new Map();
for (const [id, us] of self) {
  const key = label(byId.get(id).callFrame);
  selfByLabel.set(key, (selfByLabel.get(key) ?? 0) + us);
}
console.log(`\n== top ${topN} functions by self time (excluding idle)`);
for (const [key, us] of [...selfByLabel].filter(([k]) => !k.startsWith("(idle)")).sort((a, b) => b[1] - a[1]).slice(0, topN)) {
  console.log(`${pct(us)}  ${key}`);
}

// Inclusive time: add each sample's weight to every distinct frame on its stack.
const inclusive = new Map();
for (const [id, us] of self) {
  const seen = new Set();
  for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
    const key = label(byId.get(cur).callFrame);
    if (seen.has(key)) continue;
    seen.add(key);
    inclusive.set(key, (inclusive.get(key) ?? 0) + us);
  }
}
console.log(`\n== top ${topN} functions by inclusive time (excluding root/idle/program)`);
for (const [key, us] of [...inclusive]
  .filter(([k]) => !/^\((root|idle|program|garbage collector)\)/.test(k))
  .sort((a, b) => b[1] - a[1])
  .slice(0, topN)) {
  console.log(`${pct(us)}  ${key}`);
}
