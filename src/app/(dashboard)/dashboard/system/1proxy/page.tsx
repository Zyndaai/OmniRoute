import { redirect } from "react-router";

export function loader() {
  throw redirect("/dashboard/system/proxy?tab=free-pool");
}

export default function OneProxyPage() {
  return null;
}
