// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { createRoutesStub } from "react-router";
import { DiscoveryPageClient } from "../DiscoveryPageClient";

// The results now render in the kit Table (KEA-7886), whose persistent scrollbar measures the
// table with ResizeObserver — jsdom does not implement it.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

// Stable `t` reference: useTranslations must return the SAME function across renders.
const t = (key: string, vars?: Record<string, unknown>) =>
  vars ? `${key}:${JSON.stringify(vars)}` : key;

vi.mock("use-intl", () => ({
  useTranslations: () => t,
}));

// The page reads its results in a route loader and passes them in; the component needs a router
// for `useRevalidator`.
function renderPage(results: unknown[], loadFailed = false) {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => <DiscoveryPageClient results={results as never} loadFailed={loadFailed} />,
    },
  ]);
  return render(<Stub initialEntries={["/"]} />);
}

describe("DiscoveryPageClient", () => {
  it("renders the discovery results it is given", async () => {
    renderPage([
      {
        id: 1,
        providerId: "huggingchat",
        method: "free_tier",
        authType: "none",
        feasibility: 5,
        riskLevel: "none",
        status: "verified",
        models: ["mixtral"],
      },
    ]);

    expect(await screen.findByText("huggingchat")).toBeTruthy();
    // status + risk badges render (mocked t returns the key)
    expect(screen.getByText("verified")).toBeTruthy();
  });

  it("shows the empty state when there are no results", async () => {
    renderPage([]);
    expect(await screen.findByText("emptyTitle")).toBeTruthy();
  });

  it("shows the load-failed message when the loader's read failed", async () => {
    renderPage([], true);
    expect(await screen.findByText("loadFailed")).toBeTruthy();
  });
});
