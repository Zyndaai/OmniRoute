import { redirect } from "react-router";

/**
 * /dashboard/media-providers
 * Default redirect to the embedding kind list.
 */
export function loader() {
  throw redirect("/dashboard/media-providers/embedding", 307);
}

export default function MediaProvidersPage() {
  return null;
}
