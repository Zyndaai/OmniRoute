// `/dashboard/context` is a hub with only sub-routes (settings, combos, ultra, ...) and no page
// of its own. The page redirects the parent to its canonical sub-route, honoring a legacy `?tab=`
// query for deep links.
const CONTEXT_TAB_ROUTES: Record<string, string> = {
  settings: "/dashboard/context/settings",
  combos: "/dashboard/context/combos",
  caveman: "/dashboard/context/caveman",
  rtk: "/dashboard/context/rtk",
  headroom: "/dashboard/context/headroom",
  "session-dedup": "/dashboard/context/session-dedup",
  sessionDedup: "/dashboard/context/session-dedup",
  ccr: "/dashboard/context/ccr",
  lite: "/dashboard/context/lite",
  aggressive: "/dashboard/context/aggressive",
  ultra: "/dashboard/context/ultra",
};

const DEFAULT_CONTEXT_ROUTE = "/dashboard/context/settings";

export function resolveContextRoute(value: string | undefined): string {
  return value ? CONTEXT_TAB_ROUTES[value] || DEFAULT_CONTEXT_ROUTE : DEFAULT_CONTEXT_ROUTE;
}
