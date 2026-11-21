/**
 * Minimal path patterns for the redirect, rewrite, header and authz tables:
 *
 *   `/docs/features`              literal segments
 *   `/services/:name/embed`       `:name` matches exactly one segment
 *   `/v1/:path*`                  a trailing `:path*` matches zero or more segments
 *
 * Literal segments compare case-insensitively, the way the public URL aliases have always
 * been matched (`/V1/models` is `/v1/models`).
 */

export interface PathMatch {
  params: Record<string, string>;
  /** Segments captured by the trailing `:name*`, empty when the pattern has none. */
  rest: string[];
}

interface CompiledPattern {
  segments: Array<{ literal: string } | { param: string }>;
  restParam: string | null;
}

const compiled = new Map<string, CompiledPattern>();

function compile(pattern: string): CompiledPattern {
  const cached = compiled.get(pattern);
  if (cached) return cached;
  const parts = splitPath(pattern);
  let restParam: string | null = null;
  const last = parts.at(-1);
  if (last?.startsWith(":") && last.endsWith("*")) {
    restParam = last.slice(1, -1);
    parts.pop();
  }
  const result: CompiledPattern = {
    segments: parts.map((part) =>
      part.startsWith(":") ? { param: part.slice(1) } : { literal: part.toLowerCase() }
    ),
    restParam,
  };
  compiled.set(pattern, result);
  return result;
}

function splitPath(pathname: string): string[] {
  return pathname === "/" || pathname === "" ? [] : pathname.replace(/^\//, "").split("/");
}

export function matchPathPattern(pattern: string, pathname: string): PathMatch | null {
  const { segments, restParam } = compile(pattern);
  const parts = splitPath(pathname);
  if (parts.length < segments.length) return null;
  if (!restParam && parts.length !== segments.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const part = parts[i];
    if (!part) return null;
    if ("literal" in segment) {
      if (part.toLowerCase() !== segment.literal) return null;
    } else {
      params[segment.param] = part;
    }
  }
  const rest = parts.slice(segments.length);
  if (rest.some((part) => part === "")) return null;
  if (restParam) params[restParam] = rest.join("/");
  return { params, rest };
}

/** Fills `:name` and a trailing `:name*` (dropped with its slash when empty) into `destination`. */
export function fillPathPattern(destination: string, match: PathMatch): string {
  const filled = splitPath(destination)
    .map((part) => {
      if (!part.startsWith(":")) return part;
      const name = part.endsWith("*") ? part.slice(1, -1) : part.slice(1);
      return match.params[name] ?? "";
    })
    .filter((part) => part !== "");
  return `/${filled.join("/")}`;
}
