import { useLoaderData } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import BudgetTab, { type BudgetKeysLoaderData } from "../../usage/components/BudgetTab";

type KeyRow = BudgetKeysLoaderData["keys"][number];

/**
 * Both reads are optional, as they were in the tab: no keys shows the empty state, no budgets
 * shows every key as having no limit. Only the fields the tab reads are returned.
 */
export async function loader(): Promise<BudgetKeysLoaderData> {
  const [keysData, bulk] = await Promise.all([
    apiJsonOrNull<KeyRow[] | { keys?: KeyRow[] }>("/api/keys"),
    apiJsonOrNull<{ budgets?: BudgetKeysLoaderData["budgets"] }>("/api/usage/budget/bulk"),
  ]);
  const list = Array.isArray(keysData) ? keysData : (keysData?.keys ?? []);
  return {
    keys: list.map((k) => ({ id: k.id, name: k.name, provider: k.provider })),
    budgets: bulk && typeof bulk === "object" && bulk.budgets ? bulk.budgets : {},
  };
}

export default function CostsBudgetPage() {
  const { keys, budgets } = useLoaderData<typeof loader>();
  return <BudgetTab keys={keys} budgets={budgets} />;
}
