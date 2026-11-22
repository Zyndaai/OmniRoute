import { useState, useCallback } from "react";
import { useLocale, useTranslations } from "use-intl";
import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { radarRead } from "../radarApi.server";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import { Card } from "@/shared/components";
import Button from "@/shared/components/Button";
import {
  firstProviderConnectionId,
  providerConnectionsRequestUrl,
  providerSetupConnectionUrl,
  type RadarSetupConnection,
} from "@/lib/radar/setupConnections";
import type { RadarLocalizedText } from "@/lib/radar/feedSchema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Localized text: either a plain string or an {en, pt?} object.
 * The renderer resolves the best locale with EN fallback (D25 compat).
 */
interface SetupInfo {
  keyUrl: string | null;
  steps: RadarLocalizedText[];
}

interface ProviderSetupData {
  provider: string;
  setup: SetupInfo | null;
  configured: boolean;
  connectionId: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve a LocalizedText to a display string. */
function resolveText(text: RadarLocalizedText, locale: string): string {
  if (typeof text === "string") return text;
  if (locale.toLowerCase().startsWith("pt") && text.pt) return text.pt;
  return text.en;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type SetupLoadError = "flagDisabled" | "providerNotFound" | "loadFailed";

/**
 * The provider comes from `?provider=`. Both reads are required: a 404 on the catalog means
 * the Radar flag is off; any other failure shows the generic load error.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const provider = new URL(request.url).searchParams.get("provider");
  const none = { provider, setupData: null as ProviderSetupData | null, error: null };
  if (!provider) return none;

  const [catalogRead, connectionsRead] = await Promise.all([
    radarRead<{ entries?: { provider: string; setup?: SetupInfo | null }[] }>("/api/radar/catalog"),
    radarRead<{ connections?: RadarSetupConnection[] }>(providerConnectionsRequestUrl(provider)),
  ]);
  const fail = (error: SetupLoadError) => ({ ...none, error: error as SetupLoadError | null });
  if (catalogRead.status === 404) return fail("flagDisabled");
  if (!catalogRead.body || !connectionsRead.body || !Array.isArray(catalogRead.body.entries)) {
    return fail("loadFailed");
  }

  // Find ALL entries for this provider and extract setup from the first one that has it
  const providerEntries = catalogRead.body.entries.filter((e) => e.provider === provider);
  if (providerEntries.length === 0) return fail("providerNotFound");

  // Find setup info from feed entries (they carry the setup field)
  const entryWithSetup = providerEntries.find(
    (e) => e.setup && (e.setup.steps.length > 0 || e.setup.keyUrl)
  );
  const connectionId = firstProviderConnectionId(
    Array.isArray(connectionsRead.body.connections) ? connectionsRead.body.connections : [],
    provider
  );
  return {
    provider,
    setupData: {
      provider,
      setup: entryWithSetup?.setup ?? null,
      configured: connectionId !== null,
      connectionId,
    } as ProviderSetupData | null,
    error: null as SetupLoadError | null,
  };
}

function RadarSetupPageContent() {
  const t = useTranslations("radarSetupPage");
  const locale = useLocale();
  const { provider, setupData, error: loadError } = useLoaderData<typeof loader>();
  const error =
    loadError === "flagDisabled"
      ? t("flagDisabled")
      : loadError === "providerNotFound"
        ? t("providerNotFound", { provider: provider ?? "" })
        : loadError === "loadFailed"
          ? t("loadFailed")
          : "";
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Test connection — uses the EXISTING connection-test endpoint
  const connectionId = setupData?.connectionId ?? null;
  const handleTestConnection = useCallback(async () => {
    if (!connectionId) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/providers/${encodeURIComponent(connectionId)}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.valid === true) {
        setTestResult({ ok: true, message: t("testSuccess") });
      } else {
        setTestResult({
          ok: false,
          message: t("testFailed"),
        });
      }
    } catch {
      setTestResult({ ok: false, message: t("testFailed") });
    } finally {
      setTesting(false);
    }
  }, [connectionId, t]);

  if (!provider) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader compact title={t("title")} />
        <Card>
          <div className="text-center py-12 text-text-muted">{t("noProvider")}</div>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        compact
        breadcrumbs={
          <Link
            to="/dashboard/radar"
            className="text-sm text-text-muted hover:text-text-main transition-colors"
          >
            ← {t("backToCatalog")}
          </Link>
        }
        title={t("setupTitle", { provider })}
        description={t("setupSubtitle")}
      />

      {error && <div className="p-3 rounded-lg bg-error/10 text-error text-sm">{error}</div>}

      {setupData ? (
        <>
          {/* Configured indicator */}
          {setupData.configured && (
            <Card>
              <div className="flex items-center gap-3 py-2">
                <span className="text-success text-xl">✓</span>
                <span className="text-success font-medium">{t("providerConfigured")}</span>
              </div>
            </Card>
          )}

          {/* Key URL */}
          {setupData.setup?.keyUrl && (
            <Card>
              <div className="flex flex-col gap-2">
                <h2 className="font-semibold">{t("getApiKey")}</h2>
                <a
                  href={setupData.setup.keyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline break-all"
                >
                  {setupData.setup.keyUrl}
                </a>
              </div>
            </Card>
          )}

          {/* Steps */}
          {setupData.setup && setupData.setup.steps.length > 0 && (
            <Card>
              <div className="flex flex-col gap-4">
                <h2 className="font-semibold">{t("setupSteps")}</h2>
                <ol className="flex flex-col gap-3">
                  {setupData.setup.steps.map((step, idx) => (
                    <li key={idx} className="flex items-start gap-3">
                      <span className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-sm font-medium">
                        {idx + 1}
                      </span>
                      <span className="text-sm text-text-muted pt-1">
                        {resolveText(step, locale)}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            </Card>
          )}

          {/* No guide available */}
          {(!setupData.setup || setupData.setup.steps.length === 0) && !setupData.setup?.keyUrl && (
            <Card>
              <div className="text-center py-8 text-text-muted">
                <p>{t("noGuide")}</p>
              </div>
            </Card>
          )}

          {/* Test connection */}
          <Card>
            <div className="flex flex-col gap-3">
              <h2 className="font-semibold">{t("testConnection")}</h2>
              <p className="text-sm text-text-muted">{t("testDescription")}</p>
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  onClick={handleTestConnection}
                  disabled={testing || !setupData.connectionId}
                >
                  {testing ? t("testing") : t("testButton")}
                </Button>
                {testResult && (
                  <span className={`text-sm ${testResult.ok ? "text-success" : "text-error"}`}>
                    {testResult.message}
                  </span>
                )}
              </div>
            </div>
          </Card>

          {/* Add connection link */}
          <Card>
            <div className="flex flex-col gap-2">
              <h2 className="font-semibold">{t("addConnection")}</h2>
              <p className="text-sm text-text-muted">{t("addConnectionDescription")}</p>
              <Link
                to={providerSetupConnectionUrl(provider)}
                className="text-primary hover:underline text-sm"
              >
                {t("addConnectionLink")}
              </Link>
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}

export default function RadarSetupPage() {
  return <RadarSetupPageContent />;
}
