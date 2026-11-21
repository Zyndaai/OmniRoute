import { data } from "react-router";

/**
 * Catch-all for URLs no other route matches. An unmatched URL runs no loader, so the root
 * boundary would render the 404 without the request's locale; matching here lets the root
 * loader run and the 404 render in the localised document. `/api/*` and `/api/v1/*` keep their
 * JSON catch-alls: a longer static prefix outranks a bare `*`.
 */
export function loader() {
  throw data(null, { status: 404 });
}

export default function NotFoundRoute() {
  return null;
}
