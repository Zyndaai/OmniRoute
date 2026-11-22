/**
 * The Models page reads the catalog, the combos and the provider health matrix in its route
 * loader (`dashboard/models/page.tsx`), which replays the `/api` routes on the server. These
 * tests drive the page through a stub router whose loader makes the same three reads through
 * the stubbed `fetch`, so each test keeps serving its fixtures from one fetch mock.
 */
import React from "react";
import {
  createBrowserRouter,
  RouterProvider,
  createStaticHandler,
  createStaticRouter,
  StaticRouterProvider,
} from "react-router";

import ModelCatalogPage, { shouldRevalidate } from "@/app/(dashboard)/dashboard/models/page";
import { flattenCatalog } from "@/app/(dashboard)/dashboard/models/modelCatalogUtils";
import { flattenCombos } from "@/app/(dashboard)/dashboard/models/comboCatalogUtils";

async function readJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, { signal: new AbortController().signal });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The page loader's result, built from the stubbed `fetch`. */
export async function modelsPageLoader() {
  const [catalogBody, combosBody, matrixBody] = await Promise.all([
    readJson("/api/models/catalog?includeHidden=1"),
    readJson("/api/combos"),
    readJson("/api/providers/health-matrix"),
  ]);
  const providerHealthMap: Record<string, "healthy" | "degraded" | "down"> = {};
  const providers = (matrixBody?.providers ?? []) as Array<{
    provider: string;
    state: "healthy" | "degraded" | "down";
  }>;
  for (const item of providers) {
    if (item.provider) providerHealthMap[item.provider] = item.state;
  }
  return {
    models: flattenCatalog(catalogBody?.catalog ?? null),
    modelsError: catalogBody === null,
    combos: flattenCombos(combosBody?.combos ?? null),
    combosError: combosBody === null,
    providerHealthMap,
  };
}

/**
 * The page inside a browser data router: it starts from the current window URL and writes URL
 * changes to `window.history`, as the app does.
 */
export function ModelsPageRoute() {
  const [router] = React.useState(() =>
    createBrowserRouter([
      {
        path: "/dashboard/models",
        Component: ModelCatalogPage,
        loader: modelsPageLoader,
        shouldRevalidate,
      },
    ])
  );
  React.useEffect(() => () => router.dispose(), [router]);
  return <RouterProvider router={router} />;
}

/** The page server-rendered at `url` with the given loader data. */
export async function renderModelsPageToHtml(
  url: string,
  data: Awaited<ReturnType<typeof modelsPageLoader>>
): Promise<string> {
  const { renderToString } = await import("react-dom/server");
  const routes = [{ path: "/dashboard/models", Component: ModelCatalogPage, loader: () => data }];
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://localhost${url}`));
  if (context instanceof Response) throw new Error("unexpected redirect");
  const router = createStaticRouter(routes, context);
  return renderToString(<StaticRouterProvider router={router} context={context} />);
}
