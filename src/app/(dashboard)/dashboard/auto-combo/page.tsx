import { redirect } from "react-router";

export function loader() {
  throw redirect("/dashboard/combos?filter=intelligent", 307);
}

export default function AutoComboRedirectPage() {
  return null;
}
