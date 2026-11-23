import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { getTestBackend } from "../../helpers/postgres.ts";
import { resetDbInstance } from "../../../src/lib/db/core";

async function columnNames(table: string): Promise<string[]> {
  const rows = await getTestBackend().query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table]
  );
  return rows.map((row) => row.column_name);
}

describe("migration 099 proxy family column", () => {
  after(async () => {
    await resetDbInstance();
  });
  it("adds a family column defaulting to 'auto' on proxy_registry", async () => {
    const cols = await columnNames("proxy_registry");
    assert.ok(cols.includes("family"), "proxy_registry.family must exist");
  });
  it("adds a family column on upstream_proxy_config", async () => {
    const cols = await columnNames("upstream_proxy_config");
    assert.ok(cols.includes("family"), "upstream_proxy_config.family must exist");
  });
});
