import { redirect } from "react-router";

export function loader() {
  throw redirect("/dashboard/quota", 307);
}

export default function LimitsRedirect() {
  return null;
}
