import { redirect } from "react-router";

export function loader() {
  throw redirect("/dashboard/context/caveman");
}

export default function CompressionPage() {
  return null;
}
