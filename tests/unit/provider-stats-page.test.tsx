// @vitest-environment jsdom
/**
 * Provider stats page: the 30-second auto-refresh pauses while the tab is hidden
 * and resumes on `visibilitychange`, and the stats card shows the start of the
 * 7-day window (windowSince) reported by the API.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import enMessages from "@/i18n/messages/en.json";

vi.mock("use-intl", () => {
  // Stable per namespace, like the real hook: the page's refresh effect depends
  // on the translator identity, so a fresh function per render would loop.
  const stable = new Map<string, unknown>();
  return {
    useTranslations: (ns: string = "common") => {
      if (!stable.has(ns)) {
        const bag = ((enMessages as Record<string, unknown>)[ns] || {}) as Record<string, string>;
        const translate = (key: string, params?: Record<string, unknown>) => {
          let str = bag[key] ?? key;
          if (params) {
            for (const [pKey, pVal] of Object.entries(params)) {
              str = str.replace(new RegExp(`\\{${pKey}\\}`, "g"), String(pVal));
            }
          }
          return str;
        };
        stable.set(ns, Object.assign(translate, { has: (key: string) => key in bag }));
      }
      return stable.get(ns);
    },
  };
});

vi.mock("@/lib/display/useProviderNodeMap", () => ({
  useProviderNodeMap: () => new Map<string, unknown>(),
  resolveProviderName: (id: string | null | undefined) => id ?? "",
}));

import ProviderStatsPage from "@/app/(dashboard)/dashboard/provider-stats/page";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

describe("ProviderStatsPage", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchCalls: number;

  const windowSince = "2026-10-12T10:00:00.000Z";
  const payload = {
    providers: [{ provider: "openai", totalRequests: 2, successfulRequests: 1, avgLatencyMs: 200 }],
    models: [],
    comboMetrics: {},
    telemetry: {},
    toolLatency: {},
    windowSince,
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    fetchCalls = 0;
    setVisibility("visible");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setVisibility("visible");
  });

  type LoaderResult = { stats: typeof payload | null; error: string | null };

  // The page reads its stats through the route loader; each loader run counts as one read.
  async function mount(
    results: (call: number) => LoaderResult = () => ({ stats: payload, error: null })
  ) {
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: ProviderStatsPage,
        loader: () => {
          fetchCalls += 1;
          return results(fetchCalls);
        },
      },
    ]);
    await act(async () => {
      root.render(<Stub initialEntries={["/"]} />);
    });
    // Settle the initial fetch (microtasks only — no timer advance, so the
    // 30-second interval cannot fire here).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("labels the stats with the start of the 7-day window", async () => {
    await mount();
    const expected = new Date(payload.windowSince).toLocaleDateString();
    expect(container.textContent).toContain(`Since ${expected}`);
    expect(container.textContent).not.toContain(payload.windowSince); // no raw ISO date
    // Unmount before the next test: the page's 30-second interval would otherwise
    // fire against the next test's fetch counter.
    act(() => root.unmount());
  });

  it("pauses the 30-second refresh while hidden and resumes on visibilitychange", async () => {
    setVisibility("hidden");
    await mount();
    expect(fetchCalls).toBe(1);

    // Two full 30-second ticks while the tab is hidden: no refetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(fetchCalls).toBe(1);

    setVisibility("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(fetchCalls).toBe(2);

    // The interval keeps running once the tab is visible.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(fetchCalls).toBe(3);
  });

  it("keeps the last good stats when a refresh fails", async () => {
    await mount((call) =>
      call === 1 ? { stats: payload, error: null } : { stats: null, error: "HTTP 503" }
    );
    expect(container.textContent).toContain("openai");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(fetchCalls).toBe(2);
    expect(container.textContent).toContain("openai");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    act(() => root.unmount());
  });

  it("shows a dismissible load-failed alert under the header when there are no stats", async () => {
    await mount(() => ({ stats: null, error: "HTTP 503" }));
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("HTTP 503");
    expect(container.querySelector("h1")?.textContent).toBeTruthy();

    const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
    expect(close).toBeTruthy();
    await act(async () => {
      close!.click();
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    // The header survives the dismissal, with its refresh button as the retry.
    expect(container.querySelector("h1")?.textContent).toBeTruthy();
    const refresh = container.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]');
    expect(refresh).toBeTruthy();
    await act(async () => {
      refresh!.click();
      await Promise.resolve();
    });
    expect(fetchCalls).toBe(2);
    act(() => root.unmount());
  });
});
