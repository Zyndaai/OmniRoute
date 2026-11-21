import { redirect } from "react-router";

export function loader() {
  throw redirect("/home");
}

export default function DashboardPage() {
  return null;
}
