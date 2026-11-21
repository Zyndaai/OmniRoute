import "./globals.css";

import type { ReactNode } from "react";
import {
  isRouteErrorResponse,
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteError,
  useRouteLoaderData,
  type LoaderFunctionArgs,
  type MetaFunction,
  type ShouldRevalidateFunctionArgs,
} from "react-router";
import { IntlProvider, useTranslations } from "use-intl";
// Kit button straight from its module (no <Icon>/iconMap): the boundary must render even when
// the rest of the page graph failed.
import { Button, buttonVariants } from "@omniroute/ui-kit/button";

import { DEFAULT_LOCALE } from "@/i18n/config";
import { IntlRoot } from "@/i18n/IntlRoot";
import { getLoadedMessages } from "@/i18n/messages";
import { getRootIntlData } from "@/i18n/request.server";
import { getRootLayoutSettings } from "@/lib/db/rootLayoutSettings";
import { BasePathNetworkProvider } from "@/shared/components/BasePathNetworkProvider";
import { LocaleAutoDetect } from "@/shared/components/LocaleAutoDetect";
import { OmniRouteLockup } from "@/shared/components/OmniRouteLogo";
import { PwaRegister } from "@/shared/components/PwaRegister";
import { ThemeProvider } from "@/shared/components/ThemeProvider";
import { PWA_THEME_COLORS } from "@/shared/constants/pwaThemeColors";
import { HIDDEN_TAB_REVEAL_SCRIPT } from "@/shared/utils/hiddenTabReveal";

const DESCRIPTION =
  "OmniRoute is an AI gateway for multi-provider LLMs. One endpoint for all your AI providers.";

export async function loader({ request }: LoaderFunctionArgs) {
  const [intl, settings] = await Promise.all([getRootIntlData(request), getRootLayoutSettings()]);
  return {
    ...intl,
    instanceName: settings.instanceName,
    // Only whether one is set: the favicon itself (possibly a large base64 image) is served by
    // /api/settings/favicon and must not travel with every page's loader data.
    hasCustomFavicon: Boolean(settings.customFaviconUrl || settings.customFaviconBase64),
  };
}

type RootData = Awaited<ReturnType<typeof loader>>;

/**
 * Locale, instance name and favicon change only through a settings save or a locale switch
 * (which reloads the document), so client navigations skip this loader. Explicit revalidation
 * (`useRevalidator().revalidate()`, a same-URL navigation) and submissions still re-run it.
 */
export function shouldRevalidate({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (formMethod || currentUrl.href === nextUrl.href) return defaultShouldRevalidate;
  return false;
}

/** Title and description; a page that exports its own `meta` replaces both. */
export const meta: MetaFunction<typeof loader> = ({ loaderData }) => [
  { title: `${loaderData?.instanceName ?? "OmniRoute"} — AI Gateway for Multi-Provider LLMs` },
  { name: "description", content: DESCRIPTION },
];

// Strips attributes that browser extensions (Bitdefender's bis_skin_checked, Grammarly's
// data-gr-ext-installed, LanguageTool's data-lt-installed, etc.) inject between the server
// render and hydration, which would otherwise cause hydration mismatch warnings. Late
// injections are observed for 5 s, well past typical hydration.
const EXTENSION_ATTRS_SCRIPT = `
(function () {
  var ATTRS = ["bis_skin_checked", "data-google-query-id", "data-new-gr-c-s-check-loaded", "data-gr-ext-installed", "data-lt-installed", "data-lt-tmp-id"];
  function strip(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      if (el.hasAttribute(ATTRS[i])) el.removeAttribute(ATTRS[i]);
    }
  }
  strip(document.documentElement);
  if (typeof MutationObserver === "undefined") return;
  var obs = new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var m = muts[i];
      if (m.type === "attributes" && ATTRS.indexOf(m.attributeName) !== -1) {
        m.target.removeAttribute(m.attributeName);
      }
    }
  });
  obs.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ATTRS });
  setTimeout(function () { obs.disconnect(); }, 5000);
})();
`;

// crypto.randomUUID polyfill (missing on plain-http LAN origins), then the theme from the
// persisted `theme` store applied before the first paint so there is no light/dark flash.
const POLYFILL_AND_THEME_SCRIPT = `
if (typeof window !== 'undefined') {
  if (!window.crypto) {
    window.crypto = {};
  }
  if (!window.crypto.randomUUID) {
    window.crypto.randomUUID = function() {
      if (window.crypto.getRandomValues) {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
          const r = window.crypto.getRandomValues(new Uint8Array(1))[0] % 16;
          const v = c === 'x' ? r : (r & 0x3 | 0x8);
          return v.toString(16);
        });
      }
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    };
  }
}
try {
  const stored = localStorage.getItem('theme');
  const parsed = stored ? JSON.parse(stored) : null;
  const theme = parsed?.state?.theme || 'system';
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
} catch (e) {}
`;

/**
 * The document. It also wraps the error boundary, and on a 404 or a failed root loader there
 * is no loader data, so every field has a default. `lang` must always be set: the browser
 * reads it to load the matching catalog before hydrating (`entry.client.tsx`).
 */
export function Layout({ children }: { children: ReactNode }) {
  const data = useRouteLoaderData<typeof loader>("root") as RootData | undefined;
  const instanceName = data?.instanceName ?? "OmniRoute";

  return (
    <html
      lang={data?.locale ?? DEFAULT_LOCALE}
      dir={data?.dir ?? "ltr"}
      className="ci-theme"
      suppressHydrationWarning
    >
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta
          name="theme-color"
          media="(prefers-color-scheme: light)"
          content={PWA_THEME_COLORS.light}
        />
        <meta
          name="theme-color"
          media="(prefers-color-scheme: dark)"
          content={PWA_THEME_COLORS.dark}
        />
        {/* #16245: seed React's $RT so Suspense reveals while the tab is hidden. */}
        <script dangerouslySetInnerHTML={{ __html: HIDDEN_TAB_REVEAL_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: EXTENSION_ATTRS_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: POLYFILL_AND_THEME_SCRIPT }} />
        <Meta />
        <meta name="application-name" content={instanceName} />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content={instanceName} />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="mobile-web-app-capable" content="yes" />
        <link rel="manifest" href="/manifest.webmanifest" />
        {data?.hasCustomFavicon ? (
          <link rel="icon" href="/api/settings/favicon" />
        ) : (
          <>
            <link rel="icon" href="/favicon.ico" sizes="any" />
            <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
            <link rel="icon" href="/icon-512.png" type="image/png" sizes="512x512" />
          </>
        )}
        <link
          rel="apple-touch-icon"
          href="/apple-touch-icon.png"
          sizes="180x180"
          type="image/png"
        />
        <Links />
      </head>
      {/* No skip link here: its #main-content target exists only in the dashboard shell, which
          renders its own skip link as the first tab stop (F4). */}
      <body className="font-sans antialiased" suppressHydrationWarning>
        <IntlRoot locale={data?.locale} timeZone={data?.timeZone} now={data?.now}>
          <BasePathNetworkProvider>
            <PwaRegister />
            <LocaleAutoDetect />
            <ThemeProvider>{children}</ThemeProvider>
          </BasePathNetworkProvider>
        </IntlRoot>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

// English copies of the boundary strings (kept equal to en.json by
// tests/unit/global-error-messages.test.ts). They are used only when the catalog is not loaded:
// a 404 or a failed root loader runs no loader, and the very first request after a restart
// may have nothing cached yet. Importing the catalog here would put it in every page's bundle.
const FALLBACK_EN_NOT_FOUND = {
  title: "Page not found",
  description: "The page you're looking for doesn't exist or has been moved.",
  dashboardAriaLabel: "Return to dashboard",
  statusAriaLabel: "Open system status page",
  systemStatus: "System Status",
} as const;

const FALLBACK_EN_ERROR = {
  title: "Internal Server Error",
  description:
    "Something went wrong while processing your request. Our team has been notified and is working on a fix.",
  errorId: "Error ID: {id}",
  detailsAriaLabel: "Error details",
  retryAriaLabel: "Retry loading the page",
  tryAgain: "Try Again",
  dashboardAriaLabel: "Return to dashboard",
  statusAriaLabel: "Open system status",
  systemStatus: "System Status",
} as const;

const FALLBACK_EN_COMMON = {
  goToDashboard: "Go to Dashboard",
} as const;

const FALLBACK_EN_MESSAGES = {
  publicSystem: { notFound: FALLBACK_EN_NOT_FOUND, error: FALLBACK_EN_ERROR },
  common: FALLBACK_EN_COMMON,
};

function NotFoundContent() {
  const t = useTranslations("publicSystem");
  const tc = useTranslations("common");

  return (
    <>
      <div className="ci-dashboard-display text-[96px] leading-none mb-2" aria-hidden="true">
        404
      </div>
      <h1 id="boundary-title" className="ci-heading text-2xl mb-2">
        {t("notFound.title")}
      </h1>
      <p className="text-[15px] text-text-muted max-w-[400px] leading-relaxed mb-8">
        {t("notFound.description")}
      </p>
      <div className="flex flex-col sm:flex-row items-center gap-3">
        <Link
          reloadDocument
          to="/dashboard"
          className="px-8 py-3 rounded-xl text-sm font-medium no-underline transition-all duration-200 motion-reduce:transition-none shadow-warm hover:-translate-y-0.5 bg-primary text-accent-foreground hover:bg-primary-hover hover:shadow-elevated focus:outline-2 focus:outline-offset-2 focus:outline-primary"
          aria-label={t("notFound.dashboardAriaLabel")}
        >
          {tc("goToDashboard")}
        </Link>
        <Link
          reloadDocument
          to="/status"
          className="px-8 py-3 rounded-xl text-sm font-medium no-underline border border-border hover:bg-bg-alt transition-colors duration-200 motion-reduce:transition-none focus:outline-2 focus:outline-offset-2 focus:outline-primary"
          aria-label={t("notFound.statusAriaLabel")}
        >
          {t("notFound.systemStatus")}
        </Link>
      </div>
    </>
  );
}

function ErrorContent({ error }: { error: unknown }) {
  const t = useTranslations("publicSystem");
  const tc = useTranslations("common");
  // The raw message only in development; production output never carries error details.
  const devMessage =
    process.env.NODE_ENV === "development" && error instanceof Error ? error.message : null;

  return (
    <>
      <h1 id="boundary-title" className="ci-heading text-2xl mb-2">
        {t("error.title")}
      </h1>
      <p className="text-[15px] text-text-muted max-w-[400px] leading-relaxed mb-6">
        {t("error.description")}
      </p>
      {devMessage && (
        <pre
          className="p-4 rounded-lg bg-error-bg border border-error/30 text-error text-xs max-w-[600px] overflow-auto text-left mb-6"
          aria-label={t("error.detailsAriaLabel")}
        >
          {devMessage}
        </pre>
      )}
      <div className="flex flex-col sm:flex-row gap-3">
        {/* A full reload: the failure may be in the root loader, which a revalidation of the
            current page would not recover from. */}
        <Button
          size="lg"
          onClick={() => window.location.reload()}
          aria-label={t("error.retryAriaLabel")}
        >
          {t("error.tryAgain")}
        </Button>
        <Link
          reloadDocument
          to="/dashboard"
          className={buttonVariants({ variant: "outline", size: "lg" })}
          aria-label={t("error.dashboardAriaLabel")}
        >
          {tc("goToDashboard")}
        </Link>
        <Link
          reloadDocument
          to="/status"
          className={buttonVariants({ variant: "outline", size: "lg" })}
          aria-label={t("error.statusAriaLabel")}
        >
          {t("error.systemStatus")}
        </Link>
      </div>
    </>
  );
}

/** Not-found page for unmatched URLs and 404s thrown by loaders; error page for the rest. */
export function ErrorBoundary() {
  const error = useRouteError();
  const data = useRouteLoaderData<typeof loader>("root") as RootData | undefined;
  const notFound = isRouteErrorResponse(error) && error.status === 404;

  const page = (
    <main
      className="flex flex-col items-center justify-center min-h-screen p-6 bg-bg text-text-main text-center"
      role={notFound ? undefined : "alert"}
      aria-live={notFound ? undefined : "assertive"}
      aria-labelledby="boundary-title"
    >
      <div className="mb-6 flex justify-center">
        <OmniRouteLockup />
      </div>
      {notFound ? <NotFoundContent /> : <ErrorContent error={error} />}
    </main>
  );

  if (getLoadedMessages(data?.locale ?? DEFAULT_LOCALE)) return page;
  return (
    <IntlProvider locale={DEFAULT_LOCALE} messages={FALLBACK_EN_MESSAGES}>
      {page}
    </IntlProvider>
  );
}
