// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { translationMock } = vi.hoisted(() => ({
  translationMock: (key: string) => key,
}));

vi.mock("use-intl", () => ({
  useTranslations: () => translationMock,
}));

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  Link: ({
    to,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/shared/components", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/lib/radar/autoSync", () => ({
  shouldAutoSyncOnOpen: () => false,
}));

vi.mock("@/lib/radar/supporterKey", () => ({
  isValidSupporterKeyFormat: () => true,
}));

vi.mock("../../src/app/(dashboard)/dashboard/radar/RadarCatalogTable", () => ({
  RadarCatalogTable: () => <div>catalog</div>,
}));

import { createRoutesStub } from "react-router";
import RadarPage from "../../src/app/(dashboard)/dashboard/radar/page";

/** What the route loader returns when the feature exists but the owner has not opted in. */
const OPT_IN_PENDING = {
  featureAvailable: true,
  optIn: false,
  hasSupporterKey: false,
  supporterKeyMasked: null,
  contributorClaimUrl: "https://radar.example.test/auth/github",
  supporterPlansUrl: "https://radar.example.test/planos",
  entries: [],
  meta: null,
  catalogError: "",
  referrals: { fixed: [], campaigns: [], tier: null },
  localStates: [],
};

/** The page needs a data router for its loader data: serve `data` as the loader result. */
function renderRadarPage(root: Root, data: typeof OPT_IN_PENDING) {
  const Stub = createRoutesStub([{ path: "/", Component: RadarPage, loader: () => data }]);
  root.render(<Stub initialEntries={["/"]} />);
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

describe("Radar opt-in page", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders activation when the feature exists but the owner has not opted in", async () => {
    await act(async () => {
      renderRadarPage(root, OPT_IN_PENDING);
    });
    await settle();

    expect(container.textContent).not.toContain("notFound.title");
    expect(container.textContent).toContain("activateTitle");
    expect(container.textContent).toContain("activateButton");
    const activationIcon = container.querySelector(
      'svg.oi-icon[aria-hidden="true"][data-icon="radar"]'
    );
    expect(activationIcon?.getAttribute("data-icon")).toBe("radar");
    expect(container.textContent).not.toContain("📡");
  });

  it("shows the complete access and privacy explanation before every activation action", async () => {
    await act(async () => {
      renderRadarPage(root, OPT_IN_PENDING);
    });
    await settle();

    const renderedText = container.textContent ?? "";
    const explanationKeys = [
      "accessScaleTitle",
      "accessScaleIntro",
      "accessCommunityRule",
      "accessSingleUseRule",
      "accessContributorRule",
      "accessSupporterRule",
      "accessUseTitle",
      "accessInstallationRule",
      "accessAbuseRule",
      "accessOffersRule",
      "privacyTitle",
      "privacyDownloadsRule",
      "privacySendsRule",
      "privacyNeverRule",
    ];
    const firstActivationAction = Math.min(
      renderedText.indexOf("activateWithKeyButton"),
      renderedText.indexOf("activateButton")
    );

    expect(firstActivationAction).toBeGreaterThan(-1);
    for (const key of explanationKeys) {
      const position = renderedText.indexOf(key);
      expect(position, `${key} must be rendered`).toBeGreaterThan(-1);
      expect(position, `${key} must precede every activation action`).toBeLessThan(
        firstActivationAction
      );
    }
  });

  it("keeps the page hidden when the feature endpoint returns 404", async () => {
    await act(async () => {
      renderRadarPage(root, { ...OPT_IN_PENDING, featureAvailable: false, optIn: null as never });
    });
    await settle();

    expect(container.textContent).toContain("notFound.title");
    expect(container.textContent).not.toContain("activateTitle");
  });
});
