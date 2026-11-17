import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The audit logger writes through the shared PostgreSQL backend (`db()` from
// src/lib/db/pg.ts). These tests replace that executor so they never need a database.
type Executor = {
  execute: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  queryOne: ReturnType<typeof vi.fn>;
};

let executor: Executor;

beforeEach(() => {
  vi.resetModules();
  executor = { execute: vi.fn(async () => {}), query: vi.fn(async () => []), queryOne: vi.fn() };
  vi.doMock("../../../src/lib/db/pg.ts", () => ({ db: () => executor }));
});

afterEach(() => {
  vi.doUnmock("../../../src/lib/db/pg.ts");
  vi.restoreAllMocks();
});

async function loadAudit() {
  const audit = await import("../audit.ts");
  audit.__setAuditCallerIdResolverForTests(async () => "key-1");
  return audit;
}

describe("MCP audit logger", () => {
  it("inserts a hashed input and strips NUL characters from the output summary", async () => {
    const audit = await loadAudit();
    await audit.logToolCall("omniroute_get_health", { secret: "x" }, "ok\u0000done", 12.4, true);

    expect(executor.execute).toHaveBeenCalledTimes(1);
    const [sql, params] = executor.execute.mock.calls[0];
    expect(sql).toContain("INSERT INTO mcp_tool_audit");
    expect(params[0]).toBe("omniroute_get_health");
    expect(params[1]).not.toContain("secret");
    expect(String(params[2])).not.toContain("\u0000");
    expect(params[3]).toBe(12);
    expect(params[4]).toBe("key-1");
    expect(params[5]).toBe(true);
    expect(params[6]).toBeNull();
  }, 30_000);

  it("never throws when the database write fails", async () => {
    executor.execute.mockRejectedValueOnce(new Error("connection refused"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const audit = await loadAudit();

    await expect(
      audit.logToolCall("omniroute_get_health", {}, {}, 5, false, "E_FAIL")
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("maps stats rows to numbers", async () => {
    executor.queryOne.mockResolvedValueOnce({ total: "7", successRate: "0.75", avgDuration: 12 });
    executor.query.mockResolvedValueOnce([{ tool: "omniroute_get_health", count: "7" }]);
    const audit = await loadAudit();

    await expect(audit.getAuditStats()).resolves.toEqual({
      totalCalls: 7,
      successRate: 0.75,
      avgDurationMs: 12,
      topTools: [{ tool: "omniroute_get_health", count: 7 }],
    });
  });

  it("returns an empty page when the query fails", async () => {
    executor.queryOne.mockRejectedValueOnce(new Error("boom"));
    const audit = await loadAudit();

    await expect(audit.queryAuditEntries({ limit: 1 })).resolves.toEqual({
      entries: [],
      total: 0,
      limit: 50,
      offset: 0,
    });
  });

  it("has no dedicated handle to close", async () => {
    const audit = await loadAudit();
    expect(audit.closeAuditDb()).toBe(false);
  });
});
