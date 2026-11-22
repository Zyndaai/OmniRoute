import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { IntlProvider } from "use-intl";
import { afterEach, expect, it, vi } from "vitest";
import HealthPage from "../../src/app/(dashboard)/dashboard/health/page";
import messages from "../../src/i18n/messages/en.json";

vi.mock("@/lib/display/useProviderNodeMap", () => ({
  useProviderNodeMap: () => ({}),
  resolveProviderName: (provider: string) => provider,
}));
vi.mock("../../src/app/(dashboard)/dashboard/health/TelemetryCard", () => ({
  default: () => null,
}));
vi.mock("../../src/app/(dashboard)/dashboard/health/ProviderHealthAutopilotCard", () => ({
  default: () => null,
}));
vi.mock("../../src/app/(dashboard)/dashboard/health/ProviderHealthMatrixCard", () => ({
  default: () => null,
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("keeps queue polling and refresh mounted through health failures", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    if (input === "/api/admin/concurrency") {
      return new Response(
        JSON.stringify({ timestamp: new Date().toISOString(), comboQueues: {}, semaphores: {} })
      );
    }
    return new Response("{}");
  });
  vi.stubGlobal("fetch", fetchMock);
  // The health snapshot is read by the route loader: serve a failed read as its result.
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: HealthPage,
      loader: () => ({
        health: null,
        healthError: "HTTP 503",
        dbHealth: null,
        cache: null,
        signatureCache: null,
        degradation: null,
        autopilot: null,
      }),
    },
  ]);
  render(
    <IntlProvider locale="en" timeZone="UTC" messages={messages}>
      <Stub initialEntries={["/"]} />
    </IntlProvider>
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByText("Failed to load health data: HTTP 503")).toBeTruthy();
  // The queue card mounts with the page and fetches its own snapshot.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getAllByText("No gates tracked in this snapshot.")).toHaveLength(2);
  expect(screen.getAllByText("No gates tracked in this snapshot.")).toHaveLength(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  const queueCalls = () => fetchMock.mock.calls.filter(([url]) => url === "/api/admin/concurrency");
  expect(queueCalls()).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await act(async () => {});
  expect(queueCalls()).toHaveLength(3);
  // The page's own snapshot never goes through the browser's fetch any more.
  expect(fetchMock.mock.calls.filter(([url]) => url === "/api/monitoring/health")).toHaveLength(0);
});
