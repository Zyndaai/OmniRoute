import test from "node:test";
import assert from "node:assert/strict";

import {
  getTestBackend,
  truncateAll,
  withPglite,
} from "../../../helpers/postgres.ts";
import { getBundledPostgresMigrationHead } from "../../../../src/lib/db/backends/postgres/migrationRunner.ts";

const enabled = Boolean(process.env.OMNIROUTE_TEST_POSTGRES_URL);
const skip = enabled ? false : "OMNIROUTE_TEST_POSTGRES_URL is not set";

test("process gets its own database with the migrated schema", { skip }, async () => {
  const backend = getTestBackend();
  const db = await backend.queryOne<{ name: string }>("SELECT current_database() AS name");
  assert.match(db!.name, /^omni_t_\d+_[0-9a-f]{8}$/);

  const head = await backend.queryOne<{ version: string }>(
    "SELECT version FROM _omniroute_migrations ORDER BY version DESC LIMIT 1"
  );
  assert.equal(head?.version, getBundledPostgresMigrationHead());
});

test("writes are visible and truncateAll empties them", { skip }, async () => {
  const backend = getTestBackend();
  await backend.execute("CREATE TABLE isolation_probe (id serial PRIMARY KEY, v text)");
  await backend.execute("INSERT INTO isolation_probe (v) VALUES ($1)", ["x"]);
  assert.equal((await backend.query("SELECT 1 FROM isolation_probe")).length, 1);

  await truncateAll(backend);
  assert.equal((await backend.query("SELECT 1 FROM isolation_probe")).length, 0);
  const ledger = await backend.query("SELECT 1 FROM _omniroute_migrations");
  assert.ok(ledger.length > 0, "ledger survives truncateAll");
  await backend.execute("DROP TABLE isolation_probe");
});

test("withPglite applies the migrations and passes a working backend", async () => {
  await withPglite(async (backend) => {
    const head = await backend.queryOne<{ version: string }>(
      "SELECT version FROM _omniroute_migrations ORDER BY version DESC LIMIT 1"
    );
    assert.equal(head?.version, getBundledPostgresMigrationHead());
    await backend.execute("CREATE TABLE p (id int)");
    await backend.execute("INSERT INTO p VALUES (1)");
    assert.equal((await backend.query("SELECT * FROM p")).length, 1);
  });
});
