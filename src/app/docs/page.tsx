import Icon from "@/shared/components/Icon";
import { Link, type LoaderFunctionArgs, type MetaFunction } from "react-router";
import { source } from "@/lib/source.server";
import { getTranslator } from "@/i18n/request.server";
import { pageMeta } from "@/shared/utils/pageMeta";
import { useTranslations } from "use-intl";

export async function loader({ request }: LoaderFunctionArgs) {
  const t = await getTranslator("docs", request);
  return {
    pages: source.getPages().map((page) => ({ url: page.url, title: page.data.title })),
    meta: {
      title: t("homeTitle"),
      description: t("homeMetadataDescription"),
      twitterDescription: t("homeTwitterDescription"),
    },
  };
}

export const meta: MetaFunction<typeof loader> = ({ loaderData, matches }) =>
  pageMeta(
    matches,
    loaderData
      ? [
          { title: loaderData.meta.title },
          { name: "description", content: loaderData.meta.description },
          { property: "og:title", content: loaderData.meta.title },
          { property: "og:description", content: loaderData.meta.description },
          { property: "og:type", content: "website" },
          { property: "og:url", content: "https://omniroute.online/docs" },
          { name: "twitter:card", content: "summary_large_image" },
          { name: "twitter:title", content: loaderData.meta.title },
          { name: "twitter:description", content: loaderData.meta.twitterDescription },
        ]
      : []
  );

const featuredLinks = [
  {
    href: "/docs/getting-started/QUICK-START",
    titleKey: "featuredQuickStartTitle",
    icon: "rocket_launch",
    descriptionKey: "featuredQuickStartDescription",
  },
  {
    href: "/docs/getting-started/AUTO-COMBO-GUIDE",
    titleKey: "featuredAutoComboTitle",
    icon: "auto_awesome",
    descriptionKey: "featuredAutoComboDescription",
  },
  {
    href: "/docs/getting-started/PROVIDERS-GUIDE",
    titleKey: "featuredProvidersTitle",
    icon: "link",
    descriptionKey: "featuredProvidersDescription",
  },
];

const sections = [
  {
    titleKey: "nonTechUsersTitle",
    subtitleKey: "nonTechUsersSubtitle",
    icon: "rocket_launch",
    color: "green",
    folders: ["getting-started", "guides"],
  },
  {
    titleKey: "techUsersTitle",
    subtitleKey: "techUsersSubtitle",
    icon: "code",
    color: "blue",
    folders: [
      "architecture",
      "reference",
      "frameworks",
      "routing",
      "security",
      "compression",
      "ops",
      "providers",
      "comparison",
    ],
  },
];

export default function DocsHomePage({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const t = useTranslations("docs");
  const { pages } = loaderData;

  return (
    <div className="max-w-4xl mx-auto py-8 px-4">
      <div className="text-center mb-16 mt-8">
        <h1 className="ci-heading text-4xl text-fd-foreground mb-5">{t("homeTitle")}</h1>
        <p className="text-lg text-fd-muted-foreground mb-6">{t("homeDescription")}</p>
        <p className="text-sm text-fd-muted-foreground">
          {t.rich("homeSearchHint", {
            kbd: (chunks) => (
              <kbd className="px-1.5 py-0.5 bg-fd-muted border border-fd-border rounded font-mono text-xs">
                {chunks}
              </kbd>
            ),
          })}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 mb-16">
        {featuredLinks.map((link) => (
          <Link
            key={link.href}
            to={link.href}
            className="flex flex-col items-center text-center p-6 bg-fd-card border border-fd-border rounded-xl
              hover:border-fd-primary hover:bg-fd-accent transition-all group"
          >
            <Icon name={link.icon} size={30} className="text-primary mb-3" />
            <span className="font-semibold text-fd-foreground group-hover:text-primary transition-colors">
              {t(link.titleKey)}
            </span>
            <span className="text-sm text-fd-muted-foreground mt-2">{t(link.descriptionKey)}</span>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 pb-12">
        {sections.map((section) => {
          const sectionPages = pages.filter((p) =>
            section.folders.some((folder) => p.url.startsWith(`/docs/${folder}/`))
          );
          return (
            <div
              key={section.titleKey}
              className="border border-fd-border rounded-xl p-6 hover:border-fd-primary/30 transition-colors bg-fd-card/50"
            >
              <div className="flex items-center gap-3 mb-4">
                <Icon name={section.icon} size={24} className="text-primary" />
                <div>
                  <h2 className="ci-heading text-base text-fd-foreground">{t(section.titleKey)}</h2>
                  <p className="text-sm text-fd-muted-foreground">{t(section.subtitleKey)}</p>
                </div>
              </div>
              <ul className="space-y-2.5">
                {sectionPages.map((page) => (
                  <li key={page.url}>
                    <Link
                      to={page.url}
                      className="text-sm text-fd-muted-foreground hover:text-primary transition-colors"
                    >
                      {page.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
