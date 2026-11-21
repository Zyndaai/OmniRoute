/**
 * How folder names under `src/app/` map to URL segments. Shared by the route table
 * (`routes.ts`, build time) and the endpoint binding (`@/server/routing`, run time).
 *
 *   folder name        URL segment
 *   `name`             `name`
 *   `[id]`             `:id`
 *   `[...rest]`        `*`            (the rest of the path)
 *   `[[...rest]]`      `*`, and the parent folder's URL itself
 *   `(group)`          none           (groups files without adding a segment)
 *   `_name`            skipped
 */

export type FolderSegment =
  | { kind: "static"; path: string }
  | { kind: "param"; path: string; name: string }
  | { kind: "rest"; path: "*"; name: string; optional: boolean }
  | { kind: "group" }
  | { kind: "skip" };

export function folderSegment(folder: string): FolderSegment {
  if (folder.startsWith("_") || folder.startsWith(".")) return { kind: "skip" };
  if (/^\(.+\)$/.test(folder)) return { kind: "group" };
  const optionalRest = /^\[\[\.\.\.([^[\].]+)\]\]$/.exec(folder);
  if (optionalRest) return { kind: "rest", path: "*", name: optionalRest[1], optional: true };
  const rest = /^\[\.\.\.([^[\].]+)\]$/.exec(folder);
  if (rest) return { kind: "rest", path: "*", name: rest[1], optional: false };
  const param = /^\[([^[\].]+)\]$/.exec(folder);
  if (param) return { kind: "param", path: `:${param[1]}`, name: param[1] };
  if (/[[\]@()]/.test(folder)) {
    throw new Error(`Unsupported folder name "${folder}" under src/app`);
  }
  return { kind: "static", path: folder };
}

/**
 * URL patterns served by a file, given its folders below `src/app/`
 * (e.g. `["api", "keys", "[id]"]` gives `["/api/keys/:id"]`).
 */
export function urlPatterns(folders: string[]): string[] {
  let patterns = [""];
  for (const folder of folders) {
    const segment = folderSegment(folder);
    if (segment.kind === "skip") return [];
    if (segment.kind === "group") continue;
    const extended = patterns.map((pattern) => `${pattern}/${segment.path}`);
    patterns = segment.kind === "rest" && segment.optional ? [...extended, ...patterns] : extended;
  }
  return patterns.map((pattern) => pattern || "/");
}
