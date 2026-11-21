import { useMemo, type ComponentProps, type FC } from "react";
import { data, type MetaFunction } from "react-router";
import { DocsPage, DocsBody } from "fumadocs-ui/layouts/docs/page";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXProps } from "mdx/types";
import fs from "node:fs";
import path from "node:path";
import { resolveSafeI18nSectionDir } from "@/lib/docsI18nPath";
import { resolveDocHref, normalizeDocsMarkdownLinks } from "@/lib/docsLinkResolver";
import { getRequestLocale, getTranslator } from "@/i18n/request.server";
import { source } from "@/lib/source.server";
import { pageMeta } from "@/shared/utils/pageMeta";
import browserCollections from "../../../../.source/browser";

// ── i18n fallback ───────────────────────────────────────────────────────────
// When locale ≠ "en", try to load the translated .md from
// `docs/i18n/<locale>/docs/<section>/<FILE>.md` — the exact path layout that
// `scripts/i18n/run-translation.mjs` produces. Returns rendered HTML or null.

async function tryI18nFallback(slug: string[], locale: string): Promise<string | null> {
  if (!locale || locale === "en") return null;

  // 🛡️ Path traversal prevention — `locale` comes from a user-controllable cookie, so
  // validate segments + confine the resolved dir to docs/i18n before any fs read.
  // Centralized in resolveSafeI18nSectionDir (pure, unit-tested).
  const docsRoot = path.resolve(process.cwd(), "docs");
  const sectionDir = resolveSafeI18nSectionDir(docsRoot, locale, slug);
  if (!sectionDir) return null;

  if (!fs.existsSync(sectionDir)) return null;

  // Fumadocs lowercases slugs — match case-insensitively against i18n dir
  const target = slug[slug.length - 1];
  let files: string[];
  try {
    files = fs.readdirSync(sectionDir);
  } catch {
    return null;
  }

  const match = files.find((f) => f.toLowerCase().replace(/\.md$/, "") === target.toLowerCase());
  if (!match) return null;

  const filePath = path.join(sectionDir, match);
  const raw = fs.readFileSync(filePath, "utf8");

  // Strip the i18n header (heading + language bar + ---) before rendering.
  // Translated files have: # Title (Native)\n\n🌐 Languages: ...\n\n---\n\nbody
  const bodyMatch = raw.match(/^---\s*$/m);
  const body =
    bodyMatch && bodyMatch.index != null
      ? raw.slice(bodyMatch.index + bodyMatch[0].length).trim()
      : raw;

  // 🛡️ Sentinel: XSS protection via server-side sanitization of rendered markdown
  const [{ marked }, { sanitizeDocsHtml }] = await Promise.all([
    import("marked"),
    import("@/lib/docsSanitizer"),
  ]);
  const docRelPath = `${slug.join("/")}.md`;
  const normalizedBody = normalizeDocsMarkdownLinks(body, docRelPath);
  const html = marked.parse(normalizedBody) as string;
  return sanitizeDocsHtml(html);
}

// ── Loader ──────────────────────────────────────────────────────────────────

export async function loader({ request, params }: { request: Request; params: { "*"?: string } }) {
  const slug = (params["*"] ?? "").split("/").filter(Boolean);
  const page = source.getPage(slug);
  if (!page) throw data(null, { status: 404 });

  const [html, t] = await Promise.all([
    tryI18nFallback(slug, getRequestLocale(request)),
    getTranslator("docs", request),
  ]);
  const title = page.data.title;
  return {
    metaTitle: t("pageMetadataTitle", { title }),
    metaDescription: page.data.description ?? t("pageMetadataDescription", { title }),
    // Path of the compiled MDX module, the key of the browser collection.
    path: page.path || `${slug.join("/")}.md`,
    full: page.data.full ?? false,
    // Sanitised HTML of the translated document; null renders the English MDX.
    html,
    toc: html ? page.data.toc : null,
  };
}

// ── Page component ──────────────────────────────────────────────────────────

type DocsContentProps = {
  toc: ComponentProps<typeof DocsPage>["toc"];
  MDX: FC<MDXProps>;
  docPath: string;
  full: boolean;
};

function DocsContent({ toc, MDX, docPath, full }: DocsContentProps) {
  // Markdown links are written relative to the source file; resolve them to site URLs.
  const DocsLink = useMemo(
    () =>
      function DocsLink(linkProps: ComponentProps<typeof defaultMdxComponents.a>) {
        const resolved = linkProps.href ? resolveDocHref(linkProps.href, docPath) : linkProps.href;
        return <defaultMdxComponents.a {...linkProps} href={resolved} />;
      },
    [docPath]
  );

  return (
    <DocsPage toc={toc} full={full}>
      <DocsBody>
        <MDX components={{ ...defaultMdxComponents, a: DocsLink }} />
      </DocsBody>
    </DocsPage>
  );
}

const clientLoader = browserCollections.docs.createClientLoader<{
  docPath: string;
  full: boolean;
}>({
  component({ toc, default: MDX }, { docPath, full }) {
    return <DocsContent toc={toc} MDX={MDX} docPath={docPath} full={full} />;
  },
});

export const meta: MetaFunction<typeof loader> = ({ loaderData, matches }) =>
  pageMeta(
    matches,
    loaderData
      ? [
          { title: loaderData.metaTitle },
          { name: "description", content: loaderData.metaDescription },
        ]
      : []
  );

export default function Page({ loaderData }: { loaderData: Awaited<ReturnType<typeof loader>> }) {
  const { path: docPath, full, html, toc } = loaderData;

  return (
    <>
      {html ? (
        // Translated markdown (non-English locale with an available translation)
        <DocsPage toc={toc ?? []} full={full}>
          <DocsBody>
            <div className="prose-content" dangerouslySetInnerHTML={{ __html: html }} />
          </DocsBody>
        </DocsPage>
      ) : (
        // English MDX rendered by Fumadocs with resolved links
        clientLoader.useContent(docPath, { docPath, full })
      )}
    </>
  );
}
