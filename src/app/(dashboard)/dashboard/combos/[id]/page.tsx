import { useLoaderData } from "react-router";
import ComboControlCenterClient from "../ComboControlCenterClient";

export function loader({ params }: { params: { id?: string } }) {
  // React Router already percent-decodes route params, so `auto%2Ffast` arrives as `auto/fast`.
  return { id: params.id ?? "" };
}

export default function ComboControlCenterPage() {
  const { id } = useLoaderData<typeof loader>();
  return <ComboControlCenterClient comboId={id} />;
}
