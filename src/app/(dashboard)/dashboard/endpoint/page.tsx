import { useLoaderData } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import EndpointPageClient, {
  type EndpointLoaded,
  type EndpointSettings,
} from "./EndpointPageClient";
import { readCliKeys } from "./cliKeys.server";

/**
 * First paint of the Endpoint page: the settings the page shows, the search provider list, the
 * network info and the CLI keys. Every read is optional (the old page fell back to defaults,
 * an empty list or no URLs when one failed). Still read in the browser: the model list (a
 * `/v1` call), the MCP/A2A status and the cloudflared/tailscale/ngrok tunnel statuses (slow
 * probes of local programs).
 */
export async function loader(): Promise<EndpointLoaded> {
  const [settings, search, network, cliKeys] = await Promise.all([
    apiJsonOrNull<EndpointSettings>("/api/settings"),
    apiJsonOrNull<{ providers?: any[] }>("/api/search/providers"),
    apiJsonOrNull<NonNullable<EndpointLoaded["network"]>>("/api/network/info"),
    readCliKeys(),
  ]);
  return {
    // Only the fields the page reads.
    settings: settings
      ? {
          hideEndpointCloudflaredTunnel: settings.hideEndpointCloudflaredTunnel,
          hideEndpointTailscaleFunnel: settings.hideEndpointTailscaleFunnel,
          hideEndpointNgrokTunnel: settings.hideEndpointNgrokTunnel,
          cloudEnabled: settings.cloudEnabled,
          cloudConfigured: settings.cloudConfigured,
          cloudUrl: settings.cloudUrl,
          machineId: settings.machineId,
          ngrokAuthToken: settings.ngrokAuthToken,
          customSystemPromptEnabled: settings.customSystemPromptEnabled,
          customSystemPrompt: settings.customSystemPrompt,
        }
      : null,
    searchProviders: search?.providers || [],
    network: network
      ? {
          localUrl: network.localUrl,
          lanUrls: network.lanUrls,
          tailscaleIpUrl: network.tailscaleIpUrl,
        }
      : null,
    cliKeys,
  };
}

export default function EndpointPage() {
  const loaded = useLoaderData<typeof loader>();
  return <EndpointPageClient machineId="" loaded={loaded as EndpointLoaded} />;
}
