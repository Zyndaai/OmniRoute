import { redirect } from "react-router";

export function loader() {
  throw redirect("/dashboard/costs/pricing", 307);
}

export default function SettingsPricingPage() {
  return null;
}
