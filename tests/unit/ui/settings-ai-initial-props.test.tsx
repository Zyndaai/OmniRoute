// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ConnectionTestSettings from "@/app/(dashboard)/dashboard/settings/components/ConnectionTestSettings";
import ModalityBridgeStatsRow from "@/app/(dashboard)/dashboard/settings/components/modalityBridge/ModalityBridgeStatsRow";
import UsageTokenBufferTab from "@/app/(dashboard)/dashboard/settings/components/UsageTokenBufferTab";

vi.mock("use-intl", () => ({
  useTranslations: () => Object.assign((key: string) => key, { rich: (key: string) => key }),
}));

const roots: Array<{ root: Root; el: HTMLDivElement }> = [];
const fetchMock = vi.fn();

async function render(node: React.ReactNode): Promise<HTMLDivElement> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(node);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  roots.push({ root, el });
  return el;
}

describe("settings cards seeded from the route loader", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    for (const { root, el } of roots.splice(0)) {
      act(() => root.unmount());
      el.remove();
    }
    vi.unstubAllGlobals();
  });

  it("shows the loaded token buffer without fetching", async () => {
    const el = await render(<UsageTokenBufferTab initialBuffer={1234} />);
    expect((el.querySelector("input") as HTMLInputElement).value).toBe("1234");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the default for an unset loaded value", async () => {
    const el = await render(<UsageTokenBufferTab initialBuffer={null} />);
    expect((el.querySelector("input") as HTMLInputElement).value).toBe("2000");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the loaded connection test prompt without fetching", async () => {
    const el = await render(<ConnectionTestSettings initialPrompt="ping me" />);
    expect((el.querySelector("textarea") as HTMLTextAreaElement).value).toBe("ping me");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still fetches on mount when no initial value is given", async () => {
    await render(<UsageTokenBufferTab />);
    expect(fetchMock).toHaveBeenCalledWith("/api/settings", { cache: "no-store" });
  });

  it("renders the loaded bridge stats without fetching", async () => {
    const el = await render(
      <ModalityBridgeStatsRow
        kind="audio"
        initialStats={{
          audio: { bridged: 3, cacheHits: 1, failures: 2, lastUsedAt: null },
        }}
      />
    );
    expect(el.textContent).toContain("3");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
