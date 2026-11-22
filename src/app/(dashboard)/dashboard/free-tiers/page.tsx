import { useLoaderData } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import FreeBudgetCard, {
  type FreeBudgetData,
} from "@/app/(dashboard)/dashboard/usage/components/FreeBudgetCard";

/** Optional read: the card renders nothing when the summary is unavailable (as before). */
export async function loader() {
  return { summary: await apiJsonOrNull<FreeBudgetData>("/api/free-tier/summary") };
}

export default function FreeTiersPage() {
  const { summary } = useLoaderData<typeof loader>();
  return (
    <div className="flex flex-col gap-4">
      <FreeBudgetCard data={summary} />
    </div>
  );
}
