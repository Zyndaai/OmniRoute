import { useLoaderData } from "react-router";
import { getMachineId } from "@/shared/utils/machine";
import CliAgentsPageClient from "./CliAgentsPageClient";

export async function loader() {
  return { machineId: await getMachineId() };
}

export default function CliAgentsPage() {
  const { machineId } = useLoaderData<typeof loader>();
  return <CliAgentsPageClient machineId={machineId} />;
}
