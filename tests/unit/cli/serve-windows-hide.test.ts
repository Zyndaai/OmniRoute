/**
 * `omniroute serve` starts the server as a child process. On Windows a child of a process
 * without its own console (a detached daemon, a service, a scheduled task, a test run) gets
 * a new visible console window unless the spawn sets `windowsHide`. Both server spawns in
 * serve.mjs must set it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../../bin/cli/commands/serve.mjs", import.meta.url), "utf8");

for (const fn of ["runDaemon", "runWithoutRecovery"]) {
  test(`${fn} spawns the server with windowsHide`, () => {
    const start = source.indexOf(`function ${fn}(`);
    assert.notEqual(start, -1, `${fn} must exist in serve.mjs`);
    const spawnAt = source.indexOf("spawn(", start);
    const optionsEnd = source.indexOf(");", spawnAt);
    assert.match(source.slice(spawnAt, optionsEnd), /windowsHide: true/);
  });
}
