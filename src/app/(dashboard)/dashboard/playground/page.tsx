// src/app/(dashboard)/dashboard/playground/page.tsx
// Route shell — delegates to the PlaygroundStudio component.

import { useLoaderData } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import type { PlaygroundPresetListItem } from "@/shared/schemas/playground";
import { PlaygroundStudio } from "./PlaygroundStudio";

// Optional read: when it fails `presets` is null and the preset picker fetches (and reports the
// error) itself, as it did before. The model/provider lists come from shared translator hooks
// (outside this section) and the tabs render in the browser only, so they stay client-side.
export async function loader() {
  const body = await apiJsonOrNull<{ presets?: PlaygroundPresetListItem[] }>(
    "/api/playground/presets"
  );
  return { presets: Array.isArray(body?.presets) ? body.presets : null };
}

export default function PlaygroundPage() {
  const { presets } = useLoaderData<typeof loader>();
  return <PlaygroundStudio initialPresets={presets ?? undefined} />;
}
