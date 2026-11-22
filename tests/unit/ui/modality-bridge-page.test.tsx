// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ModalityBridgePage from "@/app/(dashboard)/dashboard/settings/modality-bridge/page";
import { loader as settingsLoader } from "@/app/(dashboard)/dashboard/settings/page";
import {
  getSectionItems,
  SIDEBAR_PRESETS,
  SIDEBAR_SECTIONS,
} from "@/shared/constants/sidebarVisibility";

const navigation = vi.hoisted(() => ({
  search: "",
  setSearchParams: vi.fn(),
}));

const messages = vi.hoisted(() => ({
  has: true,
  values: {} as Record<string, string>,
}));

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useSearchParams: () => [new URLSearchParams(navigation.search), navigation.setSearchParams],
}));

vi.mock("use-intl", () => ({
  useTranslations: () =>
    Object.assign((key: string) => messages.values[key] ?? key, { has: () => messages.has }),
}));

vi.mock(
  "@/app/(dashboard)/dashboard/settings/components/modalityBridge/ModalityBridgeVisionTab",
  () => ({ default: () => <div data-testid="vision-tab">vision</div> })
);
vi.mock(
  "@/app/(dashboard)/dashboard/settings/components/modalityBridge/ModalityBridgeAudioTab",
  () => ({ default: () => <div data-testid="audio-tab">audio</div> })
);

const roots: Array<{ root: Root; el: HTMLDivElement }> = [];

// The page reads its tab data from a route loader (mocked tabs ignore it); a data router
// supplies `useLoaderData`, and `useSearchParams` is mocked above.
function renderPage(): HTMLDivElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const router = createMemoryRouter([{ id: "page", path: "/", Component: ModalityBridgePage }], {
    hydrationData: { loaderData: { page: {} } },
  });
  act(() => root.render(<RouterProvider router={router} />));
  roots.push({ root, el });
  return el;
}

describe("Modality Bridge settings page", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    navigation.search = "";
    navigation.setSearchParams.mockReset();
    messages.has = true;
    messages.values = {};
  });

  afterEach(() => {
    for (const { root, el } of roots.splice(0)) {
      act(() => root.unmount());
      el.remove();
    }
  });

  it("renders the audio deep-link with all three modality tabs", () => {
    navigation.search = "tab=audio";
    const el = renderPage();
    expect(el.querySelectorAll('[role="tab"]')).toHaveLength(3);
    expect(el.querySelector('[data-testid="audio-tab"]')).toBeTruthy();
    expect(el.textContent).not.toContain("modalityBridgeAudioComingSoon");
    expect(el.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
      "modalityBridgeAudioTab"
    );
  });

  it("defaults invalid or missing tab values to Vision", () => {
    navigation.search = "tab=unsupported";
    const el = renderPage();
    expect(el.querySelector('[data-testid="vision-tab"]')).toBeTruthy();
  });

  it("uses catalog translations without hardcoded English fallbacks", () => {
    messages.has = false;
    messages.values = {
      modalityBridgeIntro: "Introducción localizada",
      modalityBridgeVisionTab: "Visión localizada",
      modalityBridgeAudioTab: "Audio localizado",
      modalityBridgeVideoTab: "Vídeo localizado",
      modalityBridgeSubTabsAria: "Secciones localizadas",
    };

    const el = renderPage();
    expect(Array.from(el.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent)).toEqual([
      "Visión localizada",
      "Audio localizado",
      "Vídeo localizado",
    ]);
    expect(el.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe(
      "Secciones localizadas"
    );
  });

  it("updates the URL without scrolling when an operator changes tabs", () => {
    navigation.search = "tab=vision&source=sidebar";
    const el = renderPage();
    const videoTab = Array.from(el.querySelectorAll('[role="tab"]')).find((button) =>
      button.textContent?.includes("modalityBridgeVideoTab")
    ) as HTMLButtonElement | undefined;
    act(() => videoTab?.click());
    expect(navigation.setSearchParams).toHaveBeenCalledTimes(1);
    const [params, options] = navigation.setSearchParams.mock.calls[0];
    expect(params.toString()).toBe("tab=video&source=sidebar");
    expect(options).toEqual({ replace: true, preventScrollReset: true });
  });

  it("redirects both legacy tab spellings to the dedicated page", () => {
    for (const tab of ["modality-bridge", "modalityBridge"]) {
      let thrown: unknown;
      try {
        settingsLoader({ request: new Request(`http://localhost/dashboard/settings?tab=${tab}`) });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Response);
      expect((thrown as Response).status).toBe(307);
      expect((thrown as Response).headers.get("Location")).toBe(
        "/dashboard/settings/modality-bridge"
      );
    }
  });

  it("registers the sidebar item and exposes it in developer/admin presets", () => {
    const section = SIDEBAR_SECTIONS.find((candidate) => candidate.id === "configuration");
    expect(section).toBeTruthy();
    const item = section
      ? getSectionItems(section).find((candidate) => candidate.id === "settings-modality-bridge")
      : undefined;
    expect(item).toMatchObject({
      href: "/dashboard/settings/modality-bridge",
      i18nKey: "settingsModalityBridge",
      subtitleKey: "settingsModalityBridgeSubtitle",
      icon: "image_search",
    });

    for (const presetId of ["developer", "admin"] as const) {
      const preset = SIDEBAR_PRESETS.find((candidate) => candidate.id === presetId);
      expect(preset?.hiddenItems).not.toContain("settings-modality-bridge");
    }
  });
});
