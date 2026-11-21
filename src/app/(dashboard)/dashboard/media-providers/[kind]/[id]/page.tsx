import { data, useLoaderData } from "react-router";
import { useTranslations } from "use-intl";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { resolveProviderServiceKinds } from "@omniroute/open-sse/config/mediaServiceKinds.ts";
import type { MediaKind } from "../../components/mediaKinds";
import { MEDIA_KINDS } from "../../components/mediaKinds";
import MediaProviderPageClient from "./MediaProviderPageClient";

/**
 * /dashboard/media-providers/[kind]/[id]
 *
 * Individual provider page for a media-service provider.
 * Validates both kind and id; 404 if either is unknown or the provider
 * does not declare the requested kind.
 */
export function loader({ params }: { params: { kind?: string; id?: string } }) {
  const kind = params.kind ?? "";
  const id = params.id ?? "";

  // Validate kind
  if (!MEDIA_KINDS.includes(kind as MediaKind)) {
    throw data(null, { status: 404 });
  }

  const validKind = kind as MediaKind;

  // Validate provider exists in AI_PROVIDERS
  const provider = Object.values(AI_PROVIDERS).find((p) => p.id === id) as
    | (Record<string, unknown> & {
        id: string;
        name: string;
        color?: string;
        website?: string;
        hasFree?: boolean;
        freeNote?: string;
      })
    | undefined;

  if (!provider) {
    throw data(null, { status: 404 });
  }

  // Validate that the provider supports this kind — declared serviceKinds unioned
  // with the media kinds derived from the backend registries (must mirror the
  // listing filter in ../page.tsx, otherwise a listed provider would 404 on click).
  const serviceKinds = resolveProviderServiceKinds(
    provider.id,
    provider.serviceKinds as string[] | undefined
  );
  if (!serviceKinds.includes(validKind)) {
    throw data(null, { status: 404 });
  }

  return {
    kind: validKind,
    provider: {
      id: provider.id,
      name: provider.name,
      color: provider.color,
      website: provider.website,
      hasFree: provider.hasFree,
      freeNote: provider.freeNote,
    },
  };
}

export default function MediaProviderDetailPage() {
  const { kind, provider } = useLoaderData<typeof loader>();
  const t = useTranslations("media");

  return (
    <MediaProviderPageClient
      providerId={provider.id}
      providerName={provider.name}
      providerColor={provider.color}
      kindLabel={t(`kinds.${kind}`)}
      activeKind={kind}
      website={provider.website}
      hasFree={provider.hasFree}
      freeNote={provider.freeNote}
    />
  );
}
