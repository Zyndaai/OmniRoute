#!/usr/bin/env node
// Production wrapper (Docker CMD, PM2 apps): bootstraps the env, sizes the V8 heap, then runs
// the launcher (run-server.mjs start) as a child with forwarded signals. The heap flag has to be
// on the child's command line, which is why this is a separate process.
//
// Start it from the app root (Docker WORKDIR, PM2 `cwd`): the env bootstrap reads `./.env`.
// The launcher itself changes to the app root before loading `.build/app/server/index.js`.

import { totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import {
  resolveRuntimePorts,
  withRuntimePortEnv,
  resolveMaxOldSpaceMb,
  calibrateHeapFallbackMb,
  warnConflictingHeapLimits,
  buildStandaloneNodeOptions,
  spawnWithForwardedSignals,
} from "../build/runtime-env.mjs";
import { bootstrapEnv } from "../build/bootstrap-env.mjs";

const env = bootstrapEnv();
const runtimePorts = resolveRuntimePorts(env);
const childEnv = withRuntimePortEnv(env, runtimePorts);

// #2939 / #10353: OMNIROUTE_MEMORY_MB is the Docker/standalone heap knob.
// When it is set, we append --max-old-space-size last (V8 last-flag wins).
// When it is unset and NODE_OPTIONS already pins the heap, keep NODE_OPTIONS
// (#5238). Warn when both are set and the numbers disagree.
const maxOldSpaceMb = resolveMaxOldSpaceMb(
  childEnv.OMNIROUTE_MEMORY_MB,
  calibrateHeapFallbackMb(totalmem())
);
warnConflictingHeapLimits(childEnv, maxOldSpaceMb);
childEnv.NODE_OPTIONS = buildStandaloneNodeOptions(childEnv, maxOldSpaceMb);
// The env above is final: the launcher must not bootstrap again (that would repeat the
// server.env writes and reset HOSTNAME).
childEnv.OMNIROUTE_LAUNCHER_ENV_READY = "1";

// Sibling of this file, so the same code works from scripts/dev/ and from an image that copies
// the launcher files into one folder.
const launcher = fileURLToPath(new URL("./run-server.mjs", import.meta.url));

spawnWithForwardedSignals(process.execPath, [launcher, "start"], {
  // The IPC channel closes when this process dies for any reason; the server exits with it
  // (exitWithParent in run-server.mjs), so a killed launcher never leaves an orphan on the port.
  stdio: ["inherit", "inherit", "inherit", "ipc"],
  env: childEnv,
});
