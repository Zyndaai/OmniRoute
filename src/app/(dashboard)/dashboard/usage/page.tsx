import { redirect } from "react-router";

export function loader() {
  throw redirect("/dashboard/logs", 307);
}

export default function UsageRedirectPage() {
  return null;
}
