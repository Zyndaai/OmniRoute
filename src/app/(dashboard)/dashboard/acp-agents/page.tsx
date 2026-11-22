import { Suspense, useState, useCallback } from "react";
import { Await, Link, useLoaderData, useRevalidator } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import { buttonVariants } from "@omniroute/ui-kit/button";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import Icon from "@/shared/components/Icon";
import { Card, Button, Input } from "@/shared/components";
import Badge from "@/shared/components/Badge";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { CliConceptCard, CliComparisonCard } from "@/shared/components/cli";
import { useTranslations } from "use-intl";

interface AgentInfo {
  id: string;
  name: string;
  binary: string;
  version: string | null;
  installed: boolean;
  protocol: string;
  isCustom?: boolean;
}

interface AgentSummary {
  total: number;
  installed: number;
  notFound: number;
  builtIn: number;
  custom: number;
}

// Map agent binary IDs to provider icon IDs for ProviderIcon component
const AGENT_ICON_MAP: Record<string, string> = {
  claude: "anthropic",
  "claude-code": "anthropic",
  codex: "openai",
  gemini: "google",
  opencode: "opencode",
  openclaw: "openclaw",
  cline: "cline",
  kilocode: "kilocode",
  kilo: "kilocode",
  cursor: "cursor",
  antigravity: "antigravity",
  droid: "droid",
  goose: "goose",
  aider: "aider",
  kiro: "kiro",
  nanobot: "nanobot",
  picoclaw: "picoclaw",
  zeroclaw: "zeroclaw",
  ironclaw: "ironclaw",
};

function getAgentIconId(agentId: string): string | null {
  return AGENT_ICON_MAP[agentId] || null;
}

type AgentScan = { agents: AgentInfo[]; summary: AgentSummary | null };

/**
 * The installed-agent scan runs every agent's version command (seconds when the route's 60 s
 * cache is cold), so it is not awaited: the page renders at once and the scan streams in.
 * Optional read: a failure shows the empty list, as the old page did.
 */
export function loader() {
  const scan: Promise<AgentScan> = apiJsonOrNull<{ agents?: AgentInfo[]; summary?: AgentSummary }>(
    "/api/acp/agents"
  ).then((data) => ({ agents: data?.agents || [], summary: data?.summary || null }));
  return { scan };
}

export default function AgentsPage() {
  const { scan } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const [refreshing, setRefreshing] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addLoading, setAddLoading] = useState(false);
  const [newAgent, setNewAgent] = useState({
    name: "",
    binary: "",
    versionCommand: "",
    spawnArgs: "",
  });
  const t = useTranslations("acpAgents");

  const fetchAgents = useCallback(async () => {
    await revalidator.revalidate();
  }, [revalidator]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await fetch("/api/acp/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refresh" }),
      });
      await fetchAgents();
    } catch (err) {
      console.error("Failed to refresh:", err);
    } finally {
      setRefreshing(false);
    }
  };

  const handleAddAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddLoading(true);
    try {
      const id = newAgent.name.toLowerCase().replace(/[^a-z0-9]/g, "-");
      const res = await fetch("/api/acp/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          name: newAgent.name,
          binary: newAgent.binary,
          versionCommand: newAgent.versionCommand || `${newAgent.binary} --version`,
          spawnArgs: newAgent.spawnArgs ? newAgent.spawnArgs.split(",").map((s) => s.trim()) : [],
          protocol: "stdio",
        }),
      });
      if (res.ok) {
        setNewAgent({ name: "", binary: "", versionCommand: "", spawnArgs: "" });
        setShowAddForm(false);
        await fetchAgents();
      }
    } catch (err) {
      console.error("Failed to add agent:", err);
    } finally {
      setAddLoading(false);
    }
  };

  const handleRemoveAgent = async (agentId: string) => {
    try {
      const res = await fetch(`/api/acp/agents?id=${agentId}`, { method: "DELETE" });
      if (res.ok) {
        await fetchAgents();
      }
    } catch (err) {
      console.error("Failed to remove agent:", err);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        compact
        title={t("pageTitle")}
        description={t("pageSubtitle")}
        actions={
          <Button variant="secondary" onClick={handleRefresh} loading={refreshing}>
            <Icon name="refresh" size={16} className="mr-1" />
            {t("refresh")}
          </Button>
        }
      />

      <CliConceptCard currentType="acp" />
      <CliComparisonCard currentType="acp" />

      {/* Summary Cards */}
      <Suspense fallback={null}>
        <Await resolve={scan}>
          {({ summary }) => (summary ? <AgentSummaryCards summary={summary} /> : null)}
        </Await>
      </Suspense>

      {/* Setup Guide */}
      <SetupGuideCard />

      {/* Agent Grid */}
      <Suspense
        fallback={
          <div
            role="status"
            className="flex flex-col items-center justify-center min-h-[200px] gap-3"
          >
            <Icon name="progress_activity" size={32} className="animate-spin text-primary" />
            <p className="text-sm text-text-muted">{t("scanning")}</p>
          </div>
        }
      >
        <Await resolve={scan}>
          {({ agents }) => <AgentGrid agents={agents} onRemove={handleRemoveAgent} />}
        </Await>
      </Suspense>

      {/* Add Custom Agent */}
      <AddAgentCard
        showAddForm={showAddForm}
        setShowAddForm={setShowAddForm}
        newAgent={newAgent}
        setNewAgent={setNewAgent}
        addLoading={addLoading}
        onSubmit={handleAddAgent}
      />
    </div>
  );
}

function AgentSummaryCards({ summary }: { summary: AgentSummary }) {
  const t = useTranslations("acpAgents");
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Card padding="sm" className="text-center">
        <div className="text-2xl font-bold text-primary">{summary.installed}</div>
        <div className="text-xs text-text-muted mt-1">{t("installed")}</div>
      </Card>
      <Card padding="sm" className="text-center">
        <div className="text-2xl font-bold text-text-muted">{summary.notFound}</div>
        <div className="text-xs text-text-muted mt-1">{t("notFound")}</div>
      </Card>
      <Card padding="sm" className="text-center">
        <div className="text-2xl font-bold">{summary.builtIn}</div>
        <div className="text-xs text-text-muted mt-1">{t("builtIn")}</div>
      </Card>
      <Card padding="sm" className="text-center">
        <div className="text-2xl font-bold text-warning">{summary.custom}</div>
        <div className="text-xs text-text-muted mt-1">{t("custom")}</div>
      </Card>
    </div>
  );
}

function SetupGuideCard() {
  const t = useTranslations("acpAgents");
  return (
    <Card>
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-info/10 text-info">
            <Icon name="support" size={20} />
          </div>
          <h3 className="text-lg font-semibold">{t("setupGuideTitle")}</h3>
        </div>
        <Link
          to="/dashboard/cli-code"
          className={buttonVariants({ variant: "outline", size: "sm", className: "text-xs" })}
        >
          {t("cliCodeRedirectCta")}
        </Link>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="rounded-lg border border-border/50 bg-bg-subtle p-3">
          <div className="flex items-center gap-2 mb-1.5">
            <Icon name="radar" size={16} className="text-info" />
            <p className="text-sm font-medium">{t("setupGuideDetectCliTitle")}</p>
          </div>
          <p className="text-xs text-text-muted">{t("setupGuideDetectCliDesc")}</p>
        </div>
        <div className="rounded-lg border border-border/50 bg-bg-subtle p-3">
          <div className="flex items-center gap-2 mb-1.5">
            <Icon name="build" size={16} className="text-warning" />
            <p className="text-sm font-medium">{t("setupGuideCustomAgentTitle")}</p>
          </div>
          <p className="text-xs text-text-muted">{t("setupGuideCustomAgentDesc")}</p>
        </div>
        <div className="rounded-lg border border-border/50 bg-bg-subtle p-3">
          <div className="flex items-center gap-2 mb-1.5">
            <Icon name="terminal" size={16} className="text-success" />
            <p className="text-sm font-medium">{t("setupGuideCommandMissingTitle")}</p>
          </div>
          <p className="text-xs text-text-muted">{t("setupGuideCommandMissingDesc")}</p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 rounded-lg border border-border/30 bg-bg-subtle p-3">
        <Icon name="fingerprint" size={14} className="text-text-muted" />
        <p className="text-xs text-text-muted">
          {t("fingerprintSettingsHint")}{" "}
          <Link to="/dashboard/settings?tab=routing" className="text-primary underline">
            {t("settingsRoutingLink")}
          </Link>
        </p>
      </div>
    </Card>
  );
}

function AgentGrid({
  agents,
  onRemove,
}: {
  agents: AgentInfo[];
  onRemove: (agentId: string) => void;
}) {
  const t = useTranslations("acpAgents");
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {agents.map((agent) => (
        <Card key={agent.id}>
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div
                className={`p-2 rounded-lg ${
                  agent.installed
                    ? "bg-success/10 text-success "
                    : "bg-surface-2/10 text-text-muted"
                }`}
              >
                {getAgentIconId(agent.id) ? (
                  <ProviderIcon providerId={getAgentIconId(agent.id)!} size={20} type="color" />
                ) : (
                  <Icon name={agent.installed ? "smart_toy" : "block"} size={20} />
                )}
              </div>
              <div>
                <div className="font-semibold text-sm flex items-center gap-1.5">
                  {agent.name}
                  {agent.isCustom && (
                    <Badge variant="warning" size="sm">
                      {t("custom")}
                    </Badge>
                  )}
                </div>
                <code className="text-xs text-text-muted">{agent.binary}</code>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {agent.installed ? (
                <Badge variant="success" size="sm" icon="check_circle">
                  {agent.version || t("installed")}
                </Badge>
              ) : (
                <Badge size="sm" icon="cancel">
                  {t("notFound")}
                </Badge>
              )}
            </div>
          </div>
          <div className="flex items-center justify-between mt-3 pt-3 border-t border-border/30">
            <div>
              <Badge variant="info" size="sm" className="font-mono">
                {agent.protocol}
              </Badge>
              {agent.installed && (
                <p className="mt-1 text-[10px] text-text-muted">{t("agentUseCaseHint")}</p>
              )}
            </div>
            {agent.isCustom && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onRemove(agent.id)}
                className="gap-0.5 text-xs text-error hover:bg-error/10 hover:text-error"
                title={t("remove")}
              >
                <Icon name="delete" size={14} />
                {t("remove")}
              </Button>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}

type NewAgentDraft = { name: string; binary: string; versionCommand: string; spawnArgs: string };

function AddAgentCard({
  showAddForm,
  setShowAddForm,
  newAgent,
  setNewAgent,
  addLoading,
  onSubmit,
}: {
  showAddForm: boolean;
  setShowAddForm: (open: boolean) => void;
  newAgent: NewAgentDraft;
  setNewAgent: (draft: NewAgentDraft) => void;
  addLoading: boolean;
  onSubmit: (e: React.FormEvent) => void;
}) {
  const t = useTranslations("acpAgents");
  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-warning/10 text-warning">
            <Icon name="add_circle" size={20} />
          </div>
          <div>
            <h3 className="text-lg font-semibold">{t("addCustomAgent")}</h3>
            <p className="text-sm text-text-muted">{t("addCustomAgentDesc")}</p>
          </div>
        </div>
        <Button
          variant="secondary"
          size="icon"
          onClick={() => setShowAddForm(!showAddForm)}
          aria-expanded={showAddForm}
          aria-label={t("addCustomAgent")}
        >
          <Icon name={showAddForm ? "expand_less" : "expand_more"} size={16} />
        </Button>
      </div>

      {showAddForm && (
        <form onSubmit={onSubmit} className="flex flex-col gap-4 pt-4 border-t border-border/50">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label={t("agentName")}
              placeholder={t("agentNamePlaceholder")}
              value={newAgent.name}
              onChange={(e) => setNewAgent({ ...newAgent, name: e.target.value })}
              required
            />
            <Input
              label={t("binaryName")}
              placeholder={t("binaryNamePlaceholder")}
              value={newAgent.binary}
              onChange={(e) => setNewAgent({ ...newAgent, binary: e.target.value })}
              required
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label={t("versionCommand")}
              placeholder={t("versionCommandPlaceholder")}
              value={newAgent.versionCommand}
              onChange={(e) => setNewAgent({ ...newAgent, versionCommand: e.target.value })}
            />
            <Input
              label={t("spawnArgs")}
              placeholder={t("spawnArgsPlaceholder")}
              value={newAgent.spawnArgs}
              onChange={(e) => setNewAgent({ ...newAgent, spawnArgs: e.target.value })}
            />
          </div>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={addLoading}>
              <Icon name="add" size={16} className="mr-1" />
              {t("addAgent")}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
