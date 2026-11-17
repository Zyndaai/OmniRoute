import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../server.ts";
import { MCP_TOOL_MAP, dbHealthCheckInput } from "../schemas/tools.ts";

describe("omniroute_db_health_check MCP tool", () => {
  let client: Client;

  beforeEach(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await createMcpServer();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
  });

  it("is registered in the MCP tool map", () => {
    expect(MCP_TOOL_MAP["omniroute_db_health_check"]).toBeDefined();
    expect(MCP_TOOL_MAP["omniroute_db_health_check"]?.phase).toBe(2);
  });

  it("validates empty input and explicit autoRepair requests", () => {
    expect(dbHealthCheckInput.safeParse({}).success).toBe(true);
    expect(dbHealthCheckInput.safeParse({ autoRepair: true }).success).toBe(true);
    expect(dbHealthCheckInput.safeParse({ autoRepair: "yes" }).success).toBe(false);
  });

  it("pings PostgreSQL and reports healthy with no repairs (autoRepair is a no-op)", async () => {
    const result = await client.callTool({
      name: "omniroute_db_health_check",
      arguments: { autoRepair: true },
    });

    expect(result.isError).toBeFalsy();

    const content = result.content[0] as { type: string; text: string };
    const payload = JSON.parse(content.text);
    expect(payload.isHealthy).toBe(true);
    expect(payload.issues).toEqual([]);
    expect(payload.repairedCount).toBe(0);
    expect(payload.backupCreated).toBe(false);
    expect(payload.autoRepairRequested).toBe(true);
  });
});
