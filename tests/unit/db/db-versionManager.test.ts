import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

const versionManagerDb = await import("../../../src/lib/db/versionManager.ts");
const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");

describe("db/versionManager (module coverage)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  after(async () => {
    await resetTestDb();
  });

  it("round-trips inserts, updates and status listings through the production module", async () => {
    const inserted = await versionManagerDb.upsertVersionManagerTool({
      tool: "cliproxyapi",
      installedVersion: "6.9.7",
      binaryPath: "/tmp/cliproxyapi",
      status: "installed",
      autoUpdate: false,
      autoStart: true,
      configOverrides: { port: 9999 },
    });

    assert.equal(inserted.tool, "cliproxyapi");
    assert.equal(inserted.autoUpdate, false);
    assert.equal(inserted.autoStart, true);
    assert.deepEqual(inserted.configOverrides, { port: 9999 });

    const updated = await versionManagerDb.updateVersionManagerTool("cliproxyapi", {
      installedVersion: "7.0.0",
      configOverrides: { port: 8317, host: "127.0.0.1" },
      apiKey: null,
      ignoredField: "noop",
    });

    assert.equal(updated.installedVersion, "7.0.0");
    assert.deepEqual(updated.configOverrides, { port: 8317, host: "127.0.0.1" });

    const status = await versionManagerDb.getVersionManagerStatus();
    const cliproxy = status.find((row) => row.tool === "cliproxyapi");
    assert.ok(cliproxy, "expected cliproxyapi entry in status listing");
    assert.equal(cliproxy.tool, "cliproxyapi");
  });

  it("parses invalid config overrides defensively and returns null for missing updates", async () => {
    // config_overrides is jsonb, so raw text cannot be stored; a JSON string scalar holding
    // non-JSON text is the closest stored shape the reader must still survive.
    await getTestBackend().execute(
      `INSERT INTO version_manager (tool, status, config_overrides) VALUES ($1, $2, $3::jsonb)`,
      ["broken-tool", "installed", JSON.stringify("{not-json")]
    );

    const loaded = await versionManagerDb.getVersionManagerTool("broken-tool");

    assert.equal(loaded.configOverrides, null);
    assert.equal(
      await versionManagerDb.updateVersionManagerTool("ghost", { status: "running" }),
      null
    );
  });

  it("updates health/version/status fields and deletes tools", async () => {
    await versionManagerDb.upsertVersionManagerTool({
      tool: "managed-tool",
      status: "installed",
    });

    assert.equal(await versionManagerDb.updateToolHealth("managed-tool", "healthy"), true);
    assert.equal(
      await versionManagerDb.updateToolVersion("managed-tool", "current_version", "1.2.3"),
      true
    );
    assert.equal(
      await versionManagerDb.updateToolVersion("managed-tool", "installed_version", "1.2.0"),
      true
    );
    assert.equal(await versionManagerDb.setToolStatus("managed-tool", "running", 4321, "ok"), true);
    assert.equal(await versionManagerDb.setToolStatus("managed-tool", "error"), true);

    const stored = await versionManagerDb.getVersionManagerTool("managed-tool");
    assert.equal(stored.currentVersion, "1.2.3");
    assert.equal(stored.installedVersion, "1.2.0");
    assert.equal(stored.status, "error");

    assert.equal(await versionManagerDb.updateToolHealth("ghost", "healthy"), false);
    assert.equal(await versionManagerDb.setToolStatus("ghost", "running"), false);
    assert.equal(await versionManagerDb.deleteVersionManagerTool("managed-tool"), true);
    assert.equal(await versionManagerDb.deleteVersionManagerTool("managed-tool"), false);
  });
});
