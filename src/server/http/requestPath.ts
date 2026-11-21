/**
 * The path every routing decision (redirects, authz, rewrites, security headers) is made on.
 * It must be the path React Router will match, or a request could be authorised as one route
 * and served by another: React Router strips the base path, drops a `.data` suffix (its data
 * requests run the loaders of the path without it) and percent-decodes each segment.
 */

/** `"/omniroute/"` -> `"/omniroute"`, `"/"` or empty -> `""`. */
export function normalizeBasePath(basename: string | null | undefined): string {
  const trimmed = (basename ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** `pathname` without the base path, or `null` when it lies outside it. Case-insensitive. */
export function stripBasePath(pathname: string, basePath: string): string | null {
  if (!basePath) return pathname;
  const lower = pathname.toLowerCase();
  const base = basePath.toLowerCase();
  if (lower === base) return "/";
  if (!lower.startsWith(`${base}/`)) return null;
  return pathname.slice(basePath.length);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Percent-decodes each segment like React Router does. A decoded `/` stays `%2F` so it never
 * creates a segment boundary.
 */
export function decodePathname(pathname: string): string {
  if (!pathname.includes("%")) return pathname;
  return pathname
    .split("/")
    .map((segment) => decodeSegment(segment).replace(/\//g, "%2F"))
    .join("/");
}

/** Inverse of `decodePathname` for building a URL from a decoded path. */
export function encodePathname(decoded: string): string {
  return decoded
    .split("/")
    .map((segment) =>
      encodeURI(segment.replace(/%2F/gi, "\u0000"))
        .replace(/%00/g, "%2F")
        .replace(/[?#]/g, (char) => encodeURIComponent(char))
    )
    .join("/");
}

/** The route a React Router data request (`/x.data`, `/x/_.data`) loads. */
export function stripDataSuffix(pathname: string): string {
  if (pathname.endsWith("/_.data")) return pathname.slice(0, -"_.data".length);
  if (pathname.endsWith(".data")) return pathname.slice(0, -".data".length);
  return pathname;
}

/** Path for authz and classification: no data suffix, no trailing slash. */
export function routingPathname(decodedPathname: string): string {
  const path = stripDataSuffix(decodedPathname);
  return path.replace(/\/+$/, "") || "/";
}
