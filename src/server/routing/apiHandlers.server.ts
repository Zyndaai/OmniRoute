/**
 * Every `route.ts` under `src/app/`, loaded on first use, keyed by the URL pattern it serves.
 * Server-only (`.server`): none of this reaches the browser bundle.
 */
import { folderSegment, urlPatterns } from "@/app/routeConvention";

export type ApiRouteContext = { params: Promise<Record<string, string | string[] | undefined>> };
export type ApiRouteHandler = (
  request: Request,
  context: ApiRouteContext
) => Response | Promise<Response>;
export const API_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
export type ApiMethod = (typeof API_METHODS)[number];
export type ApiRouteModule = Partial<Record<ApiMethod, ApiRouteHandler>>;

export type ApiRouteEntry = {
  file: string;
  /** Name of the `[...rest]` folder, when the route has one. */
  restParam: string | null;
  load: () => Promise<ApiRouteModule>;
};

const modules = import.meta.glob<ApiRouteModule>("/src/app/**/route.ts");

function buildTable(): Map<string, ApiRouteEntry> {
  const table = new Map<string, ApiRouteEntry>();
  for (const [file, load] of Object.entries(modules)) {
    const folders = file
      .replace(/^\/src\/app\//, "")
      .split("/")
      .slice(0, -1);
    let restParam: string | null = null;
    for (const folder of folders) {
      const segment = folderSegment(folder);
      if (segment.kind === "rest") restParam = segment.name;
    }
    for (const pattern of urlPatterns(folders)) table.set(pattern, { file, restParam, load });
  }
  return table;
}

export const apiRouteTable = buildTable();
