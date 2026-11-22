/**
 * A test that runs the CLI (bin/omniroute.mjs) with a substitute HOME must also substitute
 * USERPROFILE. On Windows os.homedir() reads USERPROFILE, not HOME, so the CLI's default data
 * dir stayed the developer's real ~/.omniroute: a CLI test wrote a .env with fresh secrets, a
 * token salt and a server pid file there (2026-11-21).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "node_modules") out.push(...testFiles(full));
    } else if (/\.test\.(ts|mts|mjs|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

test("CLI tests that replace HOME also replace USERPROFILE", () => {
  const offenders = testFiles(TESTS_ROOT).filter((file) => {
    const source = readFileSync(file, "utf8");
    return (
      /omniroute\.mjs/.test(source) && /\bHOME:\s/.test(source) && !/USERPROFILE/.test(source)
    );
  });
  assert.deepEqual(
    offenders.map((file) => path.relative(TESTS_ROOT, file)),
    [],
    "set USERPROFILE to the same temp dir as HOME"
  );
});
