// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AccessTokensTab from "@/app/(dashboard)/dashboard/settings/components/AccessTokensTab";
import AutoDisableCard from "@/app/(dashboard)/dashboard/settings/components/AutoDisableCard";
import IPFilterSection from "@/app/(dashboard)/dashboard/settings/components/IPFilterSection";

// Stable identities: the components list `t` in effect dependencies.
const { stableT, stableFormatter } = vi.hoisted(() => ({
  stableT: Object.assign((key: string) => key, { rich: (key: string) => key, has: () => false }),
  stableFormatter: { dateTime: (d: Date) => d.toISOString() },
}));
vi.mock("use-intl", () => ({
  useTranslations: () => stableT,
  useFormatter: () => stableFormatter,
}));
vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: () => ({ success: vi.fn(), error: vi.fn() }),
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

describe("settings group C components seeded from the route loader", () => {
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

  it("lists the loaded access tokens without fetching", async () => {
    const el = await render(
      <AccessTokensTab
        initialTokens={[
          {
            id: "t1",
            name: "ci-token",
            scope: "read",
            tokenPrefix: "omr_abc",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastUsedAt: null,
            expiresAt: null,
            revokedAt: null,
          },
        ]}
      />
    );
    expect(el.textContent).toContain("ci-token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still fetches the access tokens when none were loaded", async () => {
    await render(<AccessTokensTab />);
    expect(fetchMock).toHaveBeenCalledWith("/api/cli/tokens");
  });

  it("shows the loaded auto-disable card without fetching", async () => {
    const el = await render(
      <AutoDisableCard initialConfig={{ enabled: true, threshold: 5, scope: "all" }} />
    );
    expect(el.textContent).not.toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the loaded IP filter without fetching", async () => {
    await render(
      <IPFilterSection
        initialConfig={{
          enabled: true,
          mode: "blacklist",
          blacklist: ["10.0.0.1"],
          whitelist: [],
          tempBans: [],
        }}
      />
    );
    expect(document.body.textContent).toContain("10.0.0.1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("replaces the IP filter list when a new loader result arrives", async () => {
    const config = (ip: string) => ({
      enabled: true,
      mode: "blacklist",
      blacklist: [ip],
      whitelist: [],
      tempBans: [],
    });
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    roots.push({ root, el });
    await act(async () => {
      root.render(<IPFilterSection initialConfig={config("10.0.0.1")} />);
    });
    expect(el.textContent).toContain("10.0.0.1");
    await act(async () => {
      root.render(<IPFilterSection initialConfig={config("10.0.0.2")} />);
    });
    expect(el.textContent).toContain("10.0.0.2");
    expect(el.textContent).not.toContain("10.0.0.1");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
