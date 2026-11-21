import { data, Link, useLoaderData } from "react-router";
import { useTranslations } from "use-intl";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import Badge from "@/shared/components/Badge";
import EmptyState from "@/shared/components/EmptyState";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { resolveProviderServiceKinds } from "@omniroute/open-sse/config/mediaServiceKinds.ts";
import type { MediaKind } from "../components/mediaKinds";
import { MEDIA_KINDS } from "../components/mediaKinds";
import MediaProviderKindNav from "../components/MediaProviderKindNav";
import ProviderIcon from "@/shared/components/ProviderIcon";

/**
 * /dashboard/media-providers/[kind]
 *
 * Lists all AI providers that declare the given serviceKind.
 * Returns 404 for unknown kinds.
 */
export function loader({ params }: { params: { kind?: string } }) {
  const kind = params.kind ?? "";

  // Validate kind
  if (!MEDIA_KINDS.includes(kind as MediaKind)) {
    throw data(null, { status: 404 });
  }

  const validKind = kind as MediaKind;

  // Filter providers that support this kind. Membership is the union of the
  // explicitly declared serviceKinds and the media kinds derived from the
  // backend registries (audio/video/music/image/embedding) — see
  // resolveProviderServiceKinds. This keeps the UI in lockstep with the backend
  // without hand-maintaining serviceKinds on every media provider.
  const providers = Object.values(AI_PROVIDERS)
    .filter((p) => {
      const entry = p as Record<string, unknown> & { id: string; serviceKinds?: string[] };
      return resolveProviderServiceKinds(entry.id, entry.serviceKinds).includes(validKind);
    })
    .map((provider) => {
      const p = provider as Record<string, unknown> & {
        id: string;
        name: string;
        color?: string;
        hasFree?: boolean;
      };
      return { id: p.id, name: p.name, color: p.color, hasFree: Boolean(p.hasFree) };
    });

  return { kind: validKind, providers };
}

export default function MediaProviderKindPage() {
  const { kind: validKind, providers: matchingProviders } = useLoaderData<typeof loader>();
  const t = useTranslations("media");
  const tc = useTranslations("common");

  const kindLabel = t(`kinds.${validKind}`);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader compact title={kindLabel} description={t("noProviders")} />

      <MediaProviderKindNav activeKind={validKind} />

      {matchingProviders.length === 0 ? (
        <EmptyState icon="category" title={t("noProviders")} />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {matchingProviders.map((p) => (
            <Link
              key={p.id}
              to={`/dashboard/media-providers/${validKind}/${p.id}`}
              className="group"
            >
              <div className="rounded-xl border border-border bg-bg-card p-3 hover:bg-bg-subtle hover:border-primary/40 transition-colors cursor-pointer h-full flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <div
                    className="size-7 rounded-lg flex items-center justify-center shrink-0"
                    style={{ backgroundColor: `${p.color ?? "#64748b"}15` }}
                  >
                    <ProviderIcon providerId={p.id} size={20} type="color" />
                  </div>
                  <span className="text-sm font-medium truncate">{p.name}</span>
                </div>
                {p.hasFree && (
                  <Badge variant="success" size="sm" className="w-fit">
                    {tc("free")}
                  </Badge>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
