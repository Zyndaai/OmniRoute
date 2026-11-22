// @vitest-environment jsdom
//
// The document shell (`src/app/root.tsx`), the `/` entry redirect (`src/app/page.tsx`) and the
// dashboard layout's sidebar cookie (`src/app/(dashboard)/layout.tsx`): loaders, revalidation
// and the root error boundary rendered through a router.
import React from "react";
import { render, screen } from "@testing-library/react";
import { createRoutesStub, type ShouldRevalidateFunctionArgs } from "react-router";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/rootLayoutSettings", () => ({
  getRootLayoutSettings: vi.fn(async () => ({
    instanceName: "Acme Gateway",
    customFaviconUrl: "",
    customFaviconBase64: "data:image/png;base64,AAAA",
  })),
}));
vi.mock("@/i18n/request.server", () => ({
  getRootIntlData: vi.fn(async () => ({
    locale: "en",
    dir: "ltr",
    timeZone: "UTC",
    now: "2026-01-01T00:00:00.000Z",
  })),
}));
vi.mock("@/shared/components", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => children,
}));

const root = await import("../../../src/app/root");
const entry = await import("../../../src/app/page");
const dashboardLayout = await import("../../../src/app/(dashboard)/layout");

function revalidateArgs(
  current: string,
  next: string,
  extra: Partial<ShouldRevalidateFunctionArgs> = {}
): ShouldRevalidateFunctionArgs {
  return {
    currentUrl: new URL(current, "http://localhost"),
    nextUrl: new URL(next, "http://localhost"),
    currentParams: {},
    nextParams: {},
    defaultShouldRevalidate: true,
    ...extra,
  } as ShouldRevalidateFunctionArgs;
}

async function thrownResponse(fn: () => unknown): Promise<Response> {
  try {
    await fn();
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
  throw new Error("expected the loader to throw a redirect");
}

describe("root loader", () => {
  it("returns the instance name and only whether a custom favicon exists", async () => {
    const data = await root.loader({
      request: new Request("http://localhost/dashboard"),
    } as Parameters<typeof root.loader>[0]);
    expect(data.instanceName).toBe("Acme Gateway");
    expect(data.hasCustomFavicon).toBe(true);
    expect(data.locale).toBe("en");
    expect(JSON.stringify(data)).not.toContain("base64");
  });
});

describe("root shouldRevalidate", () => {
  it("skips client navigations", () => {
    expect(root.shouldRevalidate(revalidateArgs("/dashboard", "/dashboard/logs"))).toBe(false);
    expect(root.shouldRevalidate(revalidateArgs("/dashboard", "/dashboard?tab=x"))).toBe(false);
  });

  it("re-runs on explicit revalidation and submissions", () => {
    expect(root.shouldRevalidate(revalidateArgs("/dashboard", "/dashboard"))).toBe(true);
    expect(
      root.shouldRevalidate(revalidateArgs("/dashboard", "/dashboard/x", { formMethod: "POST" }))
    ).toBe(true);
  });
});

describe("root meta", () => {
  it("titles the page with the instance name, with a default when there is no data", () => {
    const meta = root.meta as (args: { loaderData: unknown }) => Array<Record<string, string>>;
    expect(meta({ loaderData: { instanceName: "Acme Gateway" } })[0].title).toMatch(
      /^Acme Gateway — /
    );
    expect(meta({ loaderData: undefined })[0].title).toMatch(/^OmniRoute — /);
  });
});

describe("root ErrorBoundary", () => {
  it("renders the not-found page for an unmatched URL", async () => {
    const Stub = createRoutesStub([
      { path: "/", Component: () => null, ErrorBoundary: root.ErrorBoundary },
    ]);
    render(<Stub initialEntries={["/does-not-exist"]} />);
    expect(await screen.findByText("404")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Page not found" })).toBeTruthy();
  });

  it("renders the error page without the raw message outside development", async () => {
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: () => null,
        ErrorBoundary: root.ErrorBoundary,
        loader() {
          throw new Error("secret database detail");
        },
      },
    ]);
    render(<Stub initialEntries={["/"]} />);
    expect(await screen.findByRole("heading", { name: "Internal Server Error" })).toBeTruthy();
    expect(screen.queryByText(/secret database detail/)).toBeNull();
  });
});

describe("/ entry loader", () => {
  it("forwards a Zed sign-in payload to /callback, keeping repeated keys", async () => {
    const res = await thrownResponse(() =>
      entry.loader({
        request: new Request("http://localhost/?user_id=u1&access_token=t1&scope=a&scope=b"),
      } as Parameters<typeof entry.loader>[0])
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "/callback?user_id=u1&access_token=t1&scope=a&scope=b"
    );
  });

  it("sends everything else to /dashboard", async () => {
    const res = await thrownResponse(() =>
      entry.loader({
        request: new Request("http://localhost/?user_id=u1"),
      } as Parameters<typeof entry.loader>[0])
    );
    expect(res.headers.get("location")).toBe("/dashboard");
  });
});

describe("dashboard layout loader", () => {
  const load = (cookie?: string) =>
    dashboardLayout.loader({
      request: new Request("http://localhost/dashboard", {
        headers: cookie ? { cookie } : {},
      }),
    } as Parameters<typeof dashboardLayout.loader>[0]);

  it("opens the sidebar unless the cookie says it was collapsed", () => {
    expect(load().sidebarDefaultOpen).toBe(true);
    expect(load("ci_sidebar_state=1").sidebarDefaultOpen).toBe(true);
    expect(load("other=x; ci_sidebar_state=0").sidebarDefaultOpen).toBe(false);
  });

  it("never re-runs after the first render", () => {
    expect(dashboardLayout.shouldRevalidate()).toBe(false);
  });

  it("marks every dashboard page response no-store (loader data carries API secrets)", () => {
    expect(dashboardLayout.headers()).toEqual({ "Cache-Control": "no-store" });
  });
});

describe("dashboard pages and headers", () => {
  it("no page under (dashboard) exports its own headers, so the layout's no-store applies", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const root = path.resolve(__dirname, "../../../src/app/(dashboard)");
    const offenders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (
          /^(page|layout)\.tsx$/.test(entry.name) &&
          full !== path.join(root, "layout.tsx")
        ) {
          if (
            /export\s+(async\s+)?function\s+headers\b|export\s+const\s+headers\b/.test(
              await readFile(full, "utf8")
            )
          ) {
            offenders.push(path.relative(root, full));
          }
        }
      }
    };
    await walk(root);
    expect(offenders).toEqual([]);
  });
});
