import type { MetaFunction } from "react-router";
import { pageMeta } from "@/shared/utils/pageMeta";
import ComboPlaygroundClient from "./ComboPlaygroundClient";

// English only: there is no catalog entry for this page's description.
export const meta: MetaFunction = ({ matches }) =>
  pageMeta(matches, [
    { title: "OmniRoute — Combo Playground" },
    { name: "description", content: "Simulate combo routing paths visually" },
  ]);

export default function ComboPlaygroundPage() {
  return <ComboPlaygroundClient />;
}
