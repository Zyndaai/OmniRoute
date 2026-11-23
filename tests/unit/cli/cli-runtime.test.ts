import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;
let origDataDir: string | undefined;

test.before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "omniroute-runtime-test-"));
  origDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
});

test.after(() => {
  if (origDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = origDataDir;
  try {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
});

test("nativeDeps.mjs pode ser importado sem erro", async () => {
  const mod = await import("../../../bin/cli/runtime/nativeDeps.mjs");
  assert.equal(typeof mod.ensureRuntimeDir, "function");
  assert.equal(typeof mod.getRuntimeNodeModules, "function");
  assert.equal(typeof mod.hasModule, "function");
  assert.equal(typeof mod.npmInstallRuntime, "function");
  assert.equal(typeof mod.buildEnvWithRuntime, "function");
});

test("ensureRuntimeDir cria diretório e package.json", async () => {
  const { ensureRuntimeDir } = await import("../../../bin/cli/runtime/nativeDeps.mjs");
  const dir = ensureRuntimeDir();
  const { existsSync } = await import("node:fs");
  assert.ok(existsSync(dir), "runtime dir deve existir");
  assert.ok(existsSync(join(dir, "package.json")), "package.json deve existir");
});

test("getRuntimeNodeModules retorna caminho dentro do DATA_DIR", async () => {
  const { getRuntimeNodeModules } = await import("../../../bin/cli/runtime/nativeDeps.mjs");
  const nm = getRuntimeNodeModules();
  assert.ok(nm.startsWith(tmpDir), "node_modules deve estar dentro do tmpDir");
  assert.ok(nm.endsWith("node_modules"), "path deve terminar com node_modules");
});

test("hasModule retorna false para módulo inexistente", async () => {
  const { hasModule } = await import("../../../bin/cli/runtime/nativeDeps.mjs");
  assert.equal(hasModule("definitely-not-installed-xyz"), false);
});

test("buildEnvWithRuntime extende NODE_PATH com runtime node_modules", async () => {
  const { buildEnvWithRuntime, getRuntimeNodeModules } =
    await import("../../../bin/cli/runtime/nativeDeps.mjs");
  const nm = getRuntimeNodeModules();
  const env = buildEnvWithRuntime({} as NodeJS.ProcessEnv);
  assert.ok(env.NODE_PATH.includes(nm), "NODE_PATH deve conter runtime node_modules");
});

test("buildEnvWithRuntime preserva NODE_PATH existente", async () => {
  const { buildEnvWithRuntime } = await import("../../../bin/cli/runtime/nativeDeps.mjs");
  const env = buildEnvWithRuntime({ NODE_PATH: "/existing/path" } as NodeJS.ProcessEnv);
  assert.ok(env.NODE_PATH.includes("/existing/path"), "NODE_PATH original deve ser preservado");
});

test("commands/runtime.mjs pode ser importado sem erro", async () => {
  const mod = await import("../../../bin/cli/commands/runtime.mjs");
  assert.equal(typeof mod.registerRuntime, "function");
});
