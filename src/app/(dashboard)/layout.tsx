import { Outlet, useLoaderData, type LoaderFunctionArgs } from "react-router";

import { DashboardLayout } from "@/shared/components";
import { requestCookie } from "@/server/requestContext";

/**
 * Dashboard chrome. The kit sidebar's collapsed state comes from its `ci_sidebar_state`
 * cookie, read here on the server, so the first paint already matches the persisted state.
 */
export function loader({ request }: LoaderFunctionArgs) {
  return { sidebarDefaultOpen: requestCookie("ci_sidebar_state", request) !== "0" };
}

/** The cookie only seeds the first render; the sidebar keeps its own state after that. */
export function shouldRevalidate() {
  return false;
}

export default function DashboardRootLayout() {
  const { sidebarDefaultOpen } = useLoaderData<typeof loader>();
  return (
    <DashboardLayout sidebarDefaultOpen={sidebarDefaultOpen}>
      <Outlet />
    </DashboardLayout>
  );
}
