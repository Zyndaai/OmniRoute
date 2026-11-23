import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CHECK = path.join(REPO_ROOT, "scripts/docker/check-base-path.mjs");

test("Dockerfile exposes OMNIROUTE_BASE_PATH as a builder-stage build arg and records it", () => {
  const dockerfile = fs.readFileSync(path.join(REPO_ROOT, "Dockerfile"), "utf8");
  assert.match(dockerfile, /ARG OMNIROUTE_BASE_PATH/);
  assert.match(dockerfile, /ENV OMNIROUTE_BASE_PATH=\$OMNIROUTE_BASE_PATH/);
  assert.match(dockerfile, /\.build\/app\/BASE_PATH/);
});

test("entrypoint runs the base-path check without failing the start", () => {
  const entrypoint = fs.readFileSync(path.join(REPO_ROOT, "scripts/check-permissions.sh"), "utf8");
  assert.match(entrypoint, /node scripts\/docker\/check-base-path\.mjs \|\| true/);
});

test("Hard Rule #13: the entrypoint never interpolates OMNIROUTE_BASE_PATH into shell", () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, "scripts/check-permissions.sh"), "utf8");
  assert.doesNotMatch(source, /\$\{?OMNIROUTE_BASE_PATH/);
});

function runCheck(built: string | null, requested: string | undefined) {
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-basepath-"));
  if (built !== null) fs.writeFileSync(path.join(buildDir, "BASE_PATH"), built);
  const env: NodeJS.ProcessEnv = { ...process.env, OMNIROUTE_BUILD_DIR: buildDir };
  delete env.OMNIROUTE_BASE_PATH;
  if (requested !== undefined) env.OMNIROUTE_BASE_PATH = requested;
  try {
    return spawnSync(process.execPath, [CHECK], { env, encoding: "utf8" });
  } finally {
    fs.rmSync(buildDir, { recursive: true, force: true });
  }
}

test("no warning when the runtime base path matches the built one", () => {
  for (const [built, requested] of [
    ["", undefined],
    ["/omniroute", "/omniroute"],
    ["/omniroute", "/omniroute/"],
  ] as const) {
    const result = runCheck(built, requested);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "", `built=${built} requested=${requested}`);
  }
});

test("a mismatch prints one warning and still exits 0", () => {
  const result = runCheck("", "/omniroute");
  assert.equal(result.status, 0);
  assert.match(result.stderr, /built for "\/"/);
  assert.match(result.stderr, /--build-arg OMNIROUTE_BASE_PATH=\/omniroute/);
});

test("a build without the record (local npm start) is not checked", () => {
  const result = runCheck(null, "/omniroute");
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});
