// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const translate = (key: string) => key;
vi.mock("use-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => Object.assign(translate, { has: () => false, rich: translate }),
}));

const { default: ApiManagerPageClient } =
  await import("@/app/(dashboard)/dashboard/api-manager/ApiManagerPageClient");

const roots: Array<{ root: ReturnType<typeof createRoot>; container: HTMLDivElement }> = [];

function mountPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({ root, container });
  // The key list comes from the route loader, so the first render already has it.
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: ApiManagerPageClient,
      loader: () => ({ keys: [], allowKeyReveal: false, quotaPoolGroup: {} }),
    },
  ]);
  act(() => root.render(<Stub initialEntries={["/"]} />));
  return container;
}

afterEach(() => {
  for (const { root, container } of roots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("API manager has no loading gate (#12066)", () => {
  it("renders the page header without a busy status once the loader has answered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) }))
    );

    const container = mountPage();
    for (let i = 0; i < 40 && !container.querySelector("h1"); i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }

    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector("h1")).not.toBeNull();
  });
});
