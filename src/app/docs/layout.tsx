import { RootProvider } from "fumadocs-ui/provider/react-router";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { Outlet, type LoaderFunctionArgs, type MetaFunction } from "react-router";
import { Suspense } from "react";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { useTranslations } from "use-intl";
import LanguageSelector from "@/shared/components/LanguageSelector";
import { getTranslator } from "@/i18n/request.server";
import { source } from "@/lib/source.server";
import { pageMeta } from "@/shared/utils/pageMeta";

// The page tree is plain data once serialised; the component rebuilds it with
// useFumadocsLoader (icons and other React nodes cannot cross the loader boundary).
export async function loader({ request }: LoaderFunctionArgs) {
  const t = await getTranslator("docs", request);
  return {
    pageTree: await source.serializePageTree(source.getPageTree()),
    title: t("metadataDefaultTitle"),
    description: t("metadataDescription"),
  };
}

/** Default title and description of the docs, plus `robots`; docs pages inherit `robots`. */
export const meta: MetaFunction<typeof loader> = ({ loaderData, matches }) =>
  pageMeta(
    matches,
    loaderData
      ? [
          { title: loaderData.title },
          { name: "description", content: loaderData.description },
          { name: "robots", content: "index, follow" },
        ]
      : []
  );

export default function Layout({ loaderData }: { loaderData: Awaited<ReturnType<typeof loader>> }) {
  const t = useTranslations("docs");
  const { pageTree } = useFumadocsLoader(loaderData);
  const docsLayoutOptions: BaseLayoutProps = {
    nav: {
      title: t("layoutNavTitle"),
      url: "/docs",
      children: (
        <Suspense fallback={<div className="w-24 h-8" />}>
          <LanguageSelector />
        </Suspense>
      ),
    },
    links: [
      {
        text: t("layoutHomeLink"),
        url: "/docs",
      },
      {
        text: t("layoutDashboardLink"),
        url: "/dashboard",
        secondary: true,
      },
    ],
    githubUrl: "https://github.com/cheaper-inference/OmniRoute",
  };

  return (
    <RootProvider
      theme={{
        defaultTheme: "dark",
        attribute: "class",
      }}
      search={{
        options: {
          api: "/docs/api/search",
        },
      }}
    >
      <DocsLayout tree={pageTree} {...docsLayoutOptions}>
        <Outlet />
      </DocsLayout>
    </RootProvider>
  );
}
