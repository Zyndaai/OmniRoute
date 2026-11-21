import { redirect, type LoaderFunctionArgs } from "react-router";

/**
 * Root entry. Zed's native-app sign-in always redirects the browser to the
 * loopback ROOT (`http://127.0.0.1:<dashboard-port>/?user_id=...&access_token=...`),
 * ignoring any path — when the dashboard port is reused as native_app_port
 * (see zed-hosted.ts), that redirect lands HERE. Forward the payload to the
 * /callback relay (which postMessages it to the waiting OAuth modal) instead of
 * the plain /dashboard redirect below, which would drop the query string.
 */
export function loader({ request }: LoaderFunctionArgs) {
  const query = new URL(request.url).searchParams;
  if (query.get("user_id") && query.get("access_token")) {
    throw redirect(`/callback?${query.toString()}`, 307);
  }
  throw redirect("/dashboard", 307);
}

export default function InitPage() {
  return null;
}
