import { useLoaderData } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import { ALL_TARGETS } from "@/mitm/targets/index";
import AgentBridgePageClient from "./AgentBridgePageClient";
import type { AgentBridgePageData } from "./AgentBridgePageClient";
import { normalizeAgentBridgeState } from "./normalizeState";

/**
 * Initial AgentBridge state for the page: whether any provider is configured, the REST API's
 * current state, and the target list (without the server-only `handler`).
 */
export async function loader() {
  // Both reads are optional: the page degrades to an empty state / safe defaults when the API
  // is not ready, and the client keeps polling /state.
  const [providersBody, stateBody] = await Promise.all([
    apiJsonOrNull<{ connections?: unknown[] }>("/api/providers"),
    apiJsonOrNull<unknown>("/api/tools/agent-bridge/state"),
  ]);

  // Any provider configured? (D15)
  const hasProviders = Array.isArray(providersBody?.connections)
    ? providersBody.connections.length > 0
    : false;

  // Falls back to a safe default if the API isn't ready yet
  let initialData: AgentBridgePageData = {
    serverState: {
      running: false,
      port: 443,
      certTrusted: false,
      upstreamCa: null,
      lastStartedAt: null,
      activeConns: 0,
      interceptedCount: 0,
      dnsConfigured: false,
      orphanedStateDetected: false,
    },
    agentStates: [],
    bypassPatterns: [],
    mappings: {},
  };

  if (stateBody) {
    // #3318: normalize — the /state route returns `{ server, agents }`, not the
    // page's `{ serverState, ... }` shape; replacing initialData verbatim left
    // serverState undefined and crashed the page.
    initialData = normalizeAgentBridgeState(stateBody);
  }

  return {
    initialData,
    targets: ALL_TARGETS.map(({ handler, ...rest }) => rest),
    hasProviders,
  };
}

export default function AgentBridgePage() {
  const { initialData, targets, hasProviders } = useLoaderData<typeof loader>();
  return (
    <AgentBridgePageClient
      initialData={initialData}
      targets={targets}
      hasProviders={hasProviders}
    />
  );
}
