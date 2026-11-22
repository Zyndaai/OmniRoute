import { useLoaderData, type MetaFunction } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import { pageMeta } from "@/shared/utils/pageMeta";
import ComboPlaygroundClient, { type Combo } from "./ComboPlaygroundClient";

/** A failed read shows "no combos configured", as the old page did (optional read). */
export async function loader() {
  const data = await apiJsonOrNull<Combo[] | { combos?: Combo[]; data?: Combo[] }>("/api/combos");
  const list = Array.isArray(data) ? data : (data?.combos ?? data?.data ?? []);
  const combos: Combo[] = list.map((c) => ({
    id: c.id,
    name: c.name,
    strategy: c.strategy,
    isActive: c.isActive,
  }));
  return { combos };
}

// English only: there is no catalog entry for this page's description.
export const meta: MetaFunction = ({ matches }) =>
  pageMeta(matches, [
    { title: "OmniRoute — Combo Playground" },
    { name: "description", content: "Simulate combo routing paths visually" },
  ]);

export default function ComboPlaygroundPage() {
  const { combos } = useLoaderData<typeof loader>();
  return <ComboPlaygroundClient combos={combos} />;
}
