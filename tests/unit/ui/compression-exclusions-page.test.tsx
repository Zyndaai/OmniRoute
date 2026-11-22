// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createRoutesStub } from "react-router";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// #8034 — dashboard tab for the per-model/endpoint compression exclusion filter. The page reads
// the stored list through its route loader (stubbed here); saves are a client PUT.

type LoaderResult = { exclusions: string[]; loadError: string | null };

async function mountPage(result: LoaderResult): Promise<HTMLElement> {
  const { default: CompressionExclusionsPage } =
    await import("../../../src/app/(dashboard)/dashboard/compression/exclusions/page");
  const Stub = createRoutesStub([
    { path: "/", Component: CompressionExclusionsPage, loader: () => result },
  ]);
  let container!: HTMLElement;
  await act(async () => {
    container = mountInContainer(<Stub initialEntries={["/"]} />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

vi.mock("use-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

const containers: HTMLElement[] = [];
const roots: Array<{ unmount: () => void }> = [];

function mountInContainer(ui: React.ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(ui);
  });
  return container;
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await act(async () => {
    while (roots.length > 0) {
      roots.pop()?.unmount();
    }
  });
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
  while (containers.length > 0) {
    containers.pop()?.remove();
  }
  document.body.innerHTML = "";
});

function setupFetchMock(exclusions: string[] = []) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init) => {
    const url = input.toString();
    if (url.includes("/api/settings/compression")) {
      if (init?.method === "PUT") {
        return new Response(JSON.stringify({ exclusions }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ exclusions }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  });
}

describe("CompressionExclusionsPage", () => {
  it("mounts, loads existing exclusions, and renders the panel", async () => {
    const container = await mountPage({
      exclusions: ["openai/text-embedding-3-large"],
      loadError: null,
    });

    expect(container).toBeTruthy();
    const textarea = container.querySelector(
      '[data-testid="compression-exclusions-textarea"]'
    ) as HTMLTextAreaElement | null;
    expect(textarea).toBeTruthy();
    expect(textarea?.value).toContain("openai/text-embedding-3-large");
  });

  it("saves edited patterns via PUT /api/settings/compression", async () => {
    setupFetchMock([]);
    const container = await mountPage({ exclusions: [], loadError: null });

    const textarea = container.querySelector(
      '[data-testid="compression-exclusions-textarea"]'
    ) as HTMLTextAreaElement;
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value"
    )?.set;

    await act(async () => {
      nativeSetter?.call(textarea, "anthropic/*\ngpt-5-6");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const saveButton = container.querySelector(
      '[data-testid="compression-exclusions-save"]'
    ) as HTMLButtonElement;
    await act(async () => {
      saveButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const putCall = (
      globalThis.fetch as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === "PUT");
    expect(putCall).toBeTruthy();
    const body = JSON.parse((putCall?.[1] as RequestInit).body as string);
    expect(body.exclusions).toEqual(["anthropic/*", "gpt-5-6"]);
  });

  it("a failed read locks the editor and shows the status instead of an empty list", async () => {
    const container = await mountPage({ exclusions: [], loadError: "503" });

    const textarea = container.querySelector(
      '[data-testid="compression-exclusions-textarea"]'
    ) as HTMLTextAreaElement;
    const saveButton = container.querySelector(
      '[data-testid="compression-exclusions-save"]'
    ) as HTMLButtonElement;
    expect(textarea.disabled).toBe(true);
    expect(saveButton.disabled).toBe(true);
    // The key-returning translator drops the {status} value; the alert itself is the signal.
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "failedLoadWithStatus"
    );
  });
});
