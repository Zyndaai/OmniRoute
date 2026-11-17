import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { resetTestDb } from "../helpers/postgres.ts";
import { createProxy, getProxyById } from "../../src/lib/db/proxies";

describe("proxies CRUD carries family", () => {
  before(() => resetTestDb());

  it("persists and returns family=ipv6", async () => {
    const created = await createProxy({
      name: "ipv6-proxy",
      type: "http",
      host: "proxy.example.com",
      port: 8080,
      family: "ipv6",
    });
    assert.ok(created?.id, "createProxy should return a record with an id");
    assert.equal(created?.family, "ipv6");

    const fetched = await getProxyById(created!.id, { includeSecrets: true });
    assert.equal(fetched?.family, "ipv6");
  });

  it("defaults family to auto when omitted", async () => {
    const created = await createProxy({
      name: "default-proxy",
      type: "http",
      host: "proxy2.example.com",
      port: 3128,
    });
    assert.ok(created?.id, "createProxy should return a record with an id");
    assert.equal(created?.family, "auto");

    const fetched = await getProxyById(created!.id, { includeSecrets: true });
    assert.equal(fetched?.family, "auto");
  });
});
