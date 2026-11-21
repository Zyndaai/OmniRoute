/**
 * Route table, built from the folder layout under `src/app/` (folder names: see
 * `./routeConvention.ts`). In each folder:
 *
 *   `page.tsx`     the page shown at the folder's URL
 *   `layout.tsx`   wraps every page below the folder (renders `<Outlet />`)
 *   `route.ts`     an HTTP endpoint at the folder's URL; exports `GET`, `POST`, ...
 *
 * Every endpoint is a resource route served by one module, `API_RESOURCE`, which calls the
 * `route.ts` file that matches the request. `root.tsx` is the document shell around every route.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  index,
  layout,
  prefix,
  route,
  type RouteConfig,
  type RouteConfigEntry,
} from "@react-router/dev/routes";

import { folderSegment } from "./routeConvention";

const APP_DIR = join(process.cwd(), "src", "app");
const API_RESOURCE = "../server/routing/apiResource.ts";
// `OMNIROUTE_BUILD_BACKEND_ONLY=1` builds the endpoints without pages and layouts.
const PAGES = process.env.OMNIROUTE_BUILD_BACKEND_ONLY !== "1";

/** Routes for one folder; paths are relative to that folder's URL. */
function scan(dir: string, rel: string): RouteConfigEntry[] {
  const at = (name: string) => (rel ? `${rel}/${name}` : name);
  const entries: RouteConfigEntry[] = [];

  if (PAGES && existsSync(join(dir, "page.tsx"))) entries.push(index(at("page.tsx")));
  if (existsSync(join(dir, "route.ts"))) {
    entries.push(route("", API_RESOURCE, { id: at("route") }));
  }

  const folders = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const name of folders) {
    const segment = folderSegment(name);
    if (segment.kind === "skip") continue;
    const children = scan(join(dir, name), at(name));
    const layoutFile =
      PAGES && existsSync(join(dir, name, "layout.tsx")) ? at(`${name}/layout.tsx`) : null;

    if (layoutFile) {
      entries.push(
        segment.kind === "group"
          ? layout(layoutFile, children)
          : route(segment.path, layoutFile, children)
      );
    } else if (segment.kind === "group") {
      entries.push(...children);
    } else {
      entries.push(...prefix(segment.path, children));
      if (segment.kind === "rest" && segment.optional) {
        // Also matches without a rest of the path: register the same files at the parent URL.
        entries.push(
          ...children.map((child) => ({ ...child, id: `${child.id ?? child.file}.base` }))
        );
      }
    }
  }
  return entries;
}

/**
 * Static segments match case-sensitively: the authz pipeline classifies the path as sent
 * (`/api/...` is MANAGEMENT or LOCAL_ONLY by prefix), so `/API/mcp/...` must not reach the
 * `/api/mcp/...` handler under another classification.
 */
function caseSensitive(entries: RouteConfigEntry[]): RouteConfigEntry[] {
  return entries.map((entry) => ({
    ...entry,
    ...(entry.path !== undefined ? { caseSensitive: true } : {}),
    ...(entry.children ? { children: caseSensitive(entry.children) } : {}),
  }));
}

export default caseSensitive(scan(APP_DIR, "")) satisfies RouteConfig;
