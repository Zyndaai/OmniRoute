import { redirect } from "react-router";

export function loader() {
  throw redirect("/dashboard/activity", 308);
}

export default function LogsActivityRedirect() {
  return null;
}
