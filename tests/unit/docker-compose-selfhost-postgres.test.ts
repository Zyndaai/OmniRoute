// The app refuses to start without OMNIROUTE_POSTGRES_URL, so the self-host compose must bring
// its own PostgreSQL: created with the C collation the schema requires, never published to the
// host, healthy before the app starts, and with a password the operator has to set.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const compose = fs.readFileSync(path.join(root, "docker-compose.selfhost.yml"), "utf8");
const envExample = fs.readFileSync(path.join(root, ".env.selfhost.example"), "utf8");

/** The block of one top-level service (its lines up to the next service or section). */
function serviceBlock(name: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `service ${name} must exist`);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n|\n[a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

test("a postgres service is created with the C collation and no published port", () => {
  const postgres = serviceBlock("postgres");
  assert.match(postgres, /image: docker\.io\/library\/postgres:18-alpine/);
  assert.match(postgres, /POSTGRES_INITDB_ARGS: "--locale=C --encoding=UTF8"/);
  assert.match(postgres, /POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD:\?/);
  assert.match(postgres, /- postgres-data:\/var\/lib\/postgresql/);
  assert.match(postgres, /pg_isready -U omniroute -d omniroute/);
  assert.doesNotMatch(postgres, /^\s*ports:/m, "the database must not be published to the host");
});

test("the app gets the database URL and waits for postgres to be healthy", () => {
  const app = serviceBlock("omniroute");
  assert.match(
    app,
    /OMNIROUTE_POSTGRES_URL=postgres:\/\/omniroute:\$\{POSTGRES_PASSWORD:\?[^}]*\}@postgres:5432\/omniroute/
  );
  assert.match(app, /depends_on:\s*\n\s+postgres:\s*\n\s+condition: service_healthy/);
  assert.match(compose, /\nvolumes:\n {2}postgres-data:\n/);
});

test("the env template asks for the password and keeps it URL-safe", () => {
  assert.match(envExample, /^POSTGRES_PASSWORD=$/m, "empty by default: compose refuses to start");
  assert.match(envExample, /openssl rand -hex 24/);
});
