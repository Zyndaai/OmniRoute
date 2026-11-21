/**
 * #4076 — Docker build fails with "JavaScript heap out of memory" during the
 * `[builder] npm run build` step. The webpack production optimization pass (forced
 * since #4052 replaced the panicking Turbopack engine) needs more heap than V8's
 * default ceiling, which a memory-constrained Docker build does not provide.
 *
 * Fix: the `builder` stage sets OMNIROUTE_BUILD_MEMORY_MB BEFORE running `npm run build`;
 * scripts/build/build.mjs turns it into `--max-old-space-size` on the `react-router build`
 * child (tests/unit/build/backend-only-smoke-workflows.test.ts covers that half).
 *
 * This guards the mechanism (the heap setting is present and ordered correctly);
 * the end-to-end "the OOM is gone" proof is a successful `docker build`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf-8");
const lines = dockerfile.split("\n");

/** Line indices that bound the `builder` stage (from its FROM to the next FROM). */
function builderStageRange(): { start: number; end: number } {
  const start = lines.findIndex((l) => /^FROM\s+\S+\s+AS\s+builder\b/i.test(l.trim()));
  assert.ok(start >= 0, "Dockerfile must declare a `builder` stage");
  const after = lines.slice(start + 1).findIndex((l) => /^FROM\s+/i.test(l.trim()));
  const end = after === -1 ? lines.length : start + 1 + after;
  return { start, end };
}

/**
 * Index of the first *instruction* line matching `re`, ignoring Dockerfile
 * comment lines (those whose trimmed text starts with `#`). #4076: a comment in
 * the builder stage that merely mentions `npm run build` must not be mistaken for
 * the real `RUN … npm run build` step when checking instruction ordering.
 */
function findInstructionIndex(stage: string[], re: RegExp): number {
  return stage.findIndex((l) => !l.trim().startsWith("#") && re.test(l));
}

const HEAP_ENV = /^ENV\s+OMNIROUTE_BUILD_MEMORY_MB=/;

test("#4076 builder stage sets the build heap ceiling", () => {
  const { start, end } = builderStageRange();
  const stage = lines.slice(start, end);
  const heapLineIdx = findInstructionIndex(stage, HEAP_ENV);
  assert.ok(
    heapLineIdx >= 0,
    "builder stage must set OMNIROUTE_BUILD_MEMORY_MB to avoid the #4076 build OOM"
  );
});

test("#4076 the heap ceiling is set BEFORE `npm run build` so it reaches the build", () => {
  const { start, end } = builderStageRange();
  const stage = lines.slice(start, end);
  const heapLineIdx = findInstructionIndex(stage, HEAP_ENV);
  const buildLineIdx = findInstructionIndex(stage, /npm run build\b/);
  assert.ok(buildLineIdx >= 0, "builder stage must run `npm run build`");
  assert.ok(heapLineIdx >= 0, "builder stage must set the heap ceiling");
  assert.ok(
    heapLineIdx < buildLineIdx,
    "the heap ceiling must be set before the `npm run build` step"
  );
});

test("#4076 the build heap default is at least 4096 MB (the V8 default ~2 GB OOMed)", () => {
  const { start, end } = builderStageRange();
  const stage = lines.slice(start, end).join("\n");
  // Match the literal default in either `--max-old-space-size=N` or an ARG default
  // referenced by the ENV (e.g. ARG OMNIROUTE_BUILD_MEMORY_MB=4096).
  const direct = stage.match(/--max-old-space-size=(\d+)/);
  const argDefault = stage.match(/ARG\s+\w*MEMORY\w*\s*=\s*(\d+)/i);
  const value = Number(direct?.[1] ?? argDefault?.[1] ?? 0);
  assert.ok(
    value >= 4096,
    `build heap default must be >= 4096 MB to clear the #4076 OOM (found ${value})`
  );
});
