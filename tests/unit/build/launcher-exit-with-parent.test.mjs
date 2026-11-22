// A server started by run-standalone.mjs must not outlive a launcher that is killed outright
// (kill -9, an out-of-memory kill). The server rehearsal found the orphan holding port 20200
// while PM2's replacement worker looped on EADDRINUSE. The launcher opens an IPC channel to the
// server; the server exits when it closes (exitWithParent in scripts/build/runtime-env.mjs).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const runtimeEnvUrl = pathToFileURL(path.resolve("scripts/build/runtime-env.mjs")).href;

// An exited child whose new parent never reaps it (a test runner as PID 1 in a container) is a
// zombie: signal 0 still succeeds, so on Linux a zombie ("Z" in /proc/<pid>/stat) counts as gone.
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return true; // no /proc (Windows, macOS): signal 0 is the answer
  }
};

async function waitFor(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

/** A parent that spawns a long-running child (with or without IPC) and prints the child's pid. */
function startPair(dir, { ipc }) {
  const child = path.join(dir, "child.mjs");
  writeFileSync(
    child,
    `import { exitWithParent } from ${JSON.stringify(runtimeEnvUrl)};
exitWithParent(() => process.exit(0));
setInterval(() => {}, 1000);
`
  );
  const parent = path.join(dir, "parent.mjs");
  writeFileSync(
    parent,
    `import { spawn } from "node:child_process";
const child = spawn(process.execPath, [${JSON.stringify(child)}], {
  stdio: ${ipc ? '["ignore", "ignore", "ignore", "ipc"]' : '"ignore"'},
});
console.log(child.pid);
setInterval(() => {}, 1000);
`
  );
  const proc = spawn(process.execPath, [parent], { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve) => {
    proc.stdout.once("data", (chunk) =>
      resolve({ parent: proc, childPid: Number(String(chunk).trim()) })
    );
  });
}

test("the server exits when its launcher is killed outright (IPC channel closes)", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "omniroute-exit-with-parent-"));
  try {
    const { parent, childPid } = await startPair(dir, { ipc: true });
    assert.ok(await waitFor(() => isAlive(childPid), 2000), "child started");
    parent.kill("SIGKILL");
    assert.ok(await waitFor(() => !isAlive(childPid), 5000), "child exits with its parent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// On Windows libuv puts children in a job object that dies with the parent, so nothing is ever
// orphaned there; production runs on Linux, where this control shows the bug.
test(
  "without the IPC channel the child would be orphaned (the bug this guards against)",
  {
    skip:
      process.platform === "win32"
        ? "children die with their parent on Windows (libuv job object)"
        : false,
  },
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "omniroute-exit-with-parent-"));
    let childPid = 0;
    try {
      const started = await startPair(dir, { ipc: false });
      childPid = started.childPid;
      started.parent.kill("SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.equal(isAlive(childPid), true, "no channel, no signal: the child keeps running");
    } finally {
      if (childPid && isAlive(childPid)) process.kill(childPid, "SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }
);

test("run-standalone opens the IPC channel and run-server exits with its parent", () => {
  const standalone = readFileSync("scripts/dev/run-standalone.mjs", "utf8");
  const server = readFileSync("scripts/dev/run-server.mjs", "utf8");
  assert.match(standalone, /stdio:\s*\[\s*"inherit",\s*"inherit",\s*"inherit",\s*"ipc"\s*\]/);
  assert.match(server, /exitWithParent\(\(\) => void shutdown\("parent-exit"\)\)/);
});
