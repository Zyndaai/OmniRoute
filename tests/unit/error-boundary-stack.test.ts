import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "../..");

test("app error boundary does not render stack traces", async () => {
  const source = await readFile(join(repoRoot, "src/app/root.tsx"), "utf8");

  assert.doesNotMatch(source, /error\.stack/);
});

test("app error boundary shows the raw error message only in development", async () => {
  const source = await readFile(join(repoRoot, "src/app/root.tsx"), "utf8");

  const uses = source.match(/error\.message/g) ?? [];
  assert.equal(uses.length, 1, "error.message is read in exactly one place");
  assert.match(
    source,
    /process\.env\.NODE_ENV === "development" && error instanceof Error \? error\.message : null/
  );
});
