// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi, beforeAll } from "vitest";

// The kit Table (KEA-7886) mounts a persistent horizontal scrollbar that measures the table
// with ResizeObserver, which jsdom does not implement.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

import enMessages from "@/i18n/messages/en.json";

vi.mock("use-intl", () => ({
  useTranslations: (ns: string = "common") => {
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
    return Object.assign(translate, { has: (key: string) => key in bag });
  },
}));

import ModelCatalogPage from "@/app/(dashboard)/dashboard/models/page";
import { flattenCatalog } from "@/app/(dashboard)/dashboard/models/modelCatalogUtils";

describe("ModelCatalogPage", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    window.history.replaceState(null, "", "/dashboard/models");
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** Mount effects are deferred with setTimeout; run them and settle the fetch promises. */
  async function flush() {
    await act(async () => {
      await vi.runAllTimersAsync();
    });
  }

  /** The page reads the catalog in its route loader: serve `data` as the loader result. */
  function renderPage(data: { models: ReturnType<typeof flattenCatalog>; modelsError: boolean }) {
    const Stub = createRoutesStub([
      {
        path: "/dashboard/models",
        Component: ModelCatalogPage,
        loader: () => ({ ...data, combos: [], combosError: false, providerHealthMap: {} }),
      },
    ]);
    act(() => {
      root.render(<Stub initialEntries={["/dashboard/models"]} />);
    });
  }

  it("loads all provider models and only labels flags the API actually reports", async () => {
    renderPage({
      modelsError: false,
      models: flattenCatalog({
        alpha: {
          provider: "Alpha Labs",
          models: [
            {
              id: "alpha-chat",
              name: "Alpha Chat",
              type: "chat",
              free: true,
              context_length: 128_000,
              capabilities: {
                tools: true,
                vision: true,
                reasoning: true,
                audio: true,
                structured_output: true,
              },
            },
          ],
        },
        beta: {
          provider: "Beta AI",
          models: [{ id: "beta-vision", name: "Beta Vision", type: "chat" }],
        },
      }),
    });
    await flush();

    expect(container.textContent).toContain("Alpha Labs");
    expect(container.textContent).toContain("Beta AI");
    expect(container.textContent).toContain("Free");
    expect(container.textContent).not.toContain("Paid");
    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "Additional capabilities: Audio, Structured output"
    );
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);

    const providerFilter = container.querySelector("select")!;
    // Filters live in the URL; the router applies the navigation asynchronously.
    await act(async () => {
      providerFilter.value = "beta";
      providerFilter.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(container.querySelector("tbody")?.textContent).toContain("Beta Vision");

    await act(async () => {
      providerFilter.value = "all";
      providerFilter.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    const modelSort = [...container.querySelectorAll<HTMLButtonElement>("th button")].find(
      (button) => button.textContent === "Model"
    )!;
    act(() => modelSort.click());
    act(() => modelSort.click());
    expect(modelSort.closest("th")?.getAttribute("aria-sort")).toBe("descending");
    expect(container.querySelector("tbody tr")?.textContent).toContain("Beta Vision");
  });

  it("shows a retry action after the catalog request fails", async () => {
    renderPage({ models: [], modelsError: true });
    await flush();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Unable to load the model catalog."
    );
    expect(
      [...container.querySelectorAll("button")].some((button) => button.textContent === "Retry")
    ).toBe(true);
  });
});
