import { redirect } from "react-router";
import { resolveContextRoute } from "./resolveContextRoute";

export function loader({ request }: { request: Request }) {
  const tab = new URL(request.url).searchParams.get("tab") ?? undefined;
  throw redirect(resolveContextRoute(tab), 307);
}

export default function ContextPage() {
  return null;
}
