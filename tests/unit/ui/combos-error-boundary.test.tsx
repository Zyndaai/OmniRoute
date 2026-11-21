// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routeState = vi.hoisted(() => ({
  error: undefined as (Error & { digest?: string }) | undefined,
  revalidate: vi.fn(),
}));

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useRouteError: () => routeState.error,
  useRevalidator: () => ({ revalidate: routeState.revalidate, state: "idle" }),
}));

const cleanupCallbacks: Array<() => void> = [];

function makeContainer(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  cleanupCallbacks.push(() => container.remove());
  return container;
}

describe("CombosError boundary", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    while (cleanupCallbacks.length > 0) cleanupCallbacks.pop()?.();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders a recoverable fallback instead of throwing", async () => {
    const { ErrorBoundary: CombosError } =
      await import("../../../src/app/(dashboard)/dashboard/combos/layout");
    const container = makeContainer();
    const root = createRoot(container);
    routeState.error = Object.assign(new Error("boom"), { digest: "abc123" });

    await act(async () => {
      root.render(<CombosError />);
    });

    expect(container.querySelector("[role='alert']")).toBeTruthy();
    expect(container.textContent).toContain("Failed to load combos");
  });

  it("revalidates exactly once when Try Again is clicked", async () => {
    const { ErrorBoundary: CombosError } =
      await import("../../../src/app/(dashboard)/dashboard/combos/layout");
    const container = makeContainer();
    const root = createRoot(container);
    routeState.error = Object.assign(new Error("boom"), { digest: undefined });

    await act(async () => {
      root.render(<CombosError />);
    });

    const button = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Try Again"
    ) as HTMLButtonElement | undefined;
    expect(button).toBeTruthy();

    await act(async () => {
      button?.click();
    });

    expect(routeState.revalidate).toHaveBeenCalledTimes(1);
  });
});
