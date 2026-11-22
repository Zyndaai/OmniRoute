import { useState, useEffect } from "react";
import { useTranslations } from "use-intl";
import {
  AI_PROVIDERS,
  CLAUDE_CODE_COMPATIBLE_PREFIX,
  OPENAI_COMPATIBLE_PREFIX,
  ANTHROPIC_COMPATIBLE_PREFIX,
} from "@/shared/constants/providers";
import { compareTr } from "@/shared/utils/turkishText";

/** The two reads the options are built from: `/api/providers` and `/api/provider-nodes`. */
export interface ProviderOptionsData {
  connections?: Array<{ provider: string; isActive?: boolean }>;
  nodes?: Array<{ id: string; name?: string; prefix?: string }>;
}

function staticProviderOptions() {
  return Object.entries(AI_PROVIDERS).map(([id, info]: [string, any]) => ({
    value: id,
    label: info.name,
  }));
}

/** Active providers as sorted options; the static AI_PROVIDERS list when none is active. */
function buildProviderOptions(data: ProviderOptionsData, t: (key: string) => string) {
  const nodeMap = new Map((data.nodes || []).map((n) => [n.id, n]));
  const activeProviders = new Set(
    (data.connections || []).filter((c) => c.isActive !== false).map((c) => c.provider)
  );
  const options = [...activeProviders]
    .map((pid) => {
      const info = (AI_PROVIDERS as any)[pid as string];
      const node: any = nodeMap.get(pid);
      let label = info?.name || node?.name || pid;
      if (!info && (pid as string).startsWith(CLAUDE_CODE_COMPATIBLE_PREFIX))
        label = node?.name || "CC Compatible";
      if (!info && (pid as string).startsWith(OPENAI_COMPATIBLE_PREFIX))
        label = node?.name || t("openaiCompatibleLabel");
      if (!info && (pid as string).startsWith(ANTHROPIC_COMPATIBLE_PREFIX))
        label = node?.name || t("anthropicCompatibleLabel");
      // #3505: compatible providers emit catalog models under the node's custom prefix
      // (e.g. "myprefix/gpt-4o"), not under the connection id (`value`). Expose the prefix
      // so model-filter consumers (playground) can match; `value` stays the id for
      // connection lookups (translator send/translate, ApiTab).
      const modelPrefix = !info && node?.prefix ? String(node.prefix) : undefined;
      return { value: pid, label, modelPrefix };
    })
    .sort((a, b) => compareTr(a.label, b.label));

  return options.length > 0 ? options : staticProviderOptions();
}

/**
 * Hook to fetch and manage provider options for the Translator tools.
 * Fetches active providers from the API and builds a sorted list of options.
 * Falls back to the static AI_PROVIDERS list if the API is unreachable.
 *
 * With `initialData` (the translator route loader's reads) the options are built on the first
 * render and nothing is fetched; without it the hook fetches on mount (Playground, test bench).
 *
 * @param {string} [initialProvider="openai"] - Initial provider value
 * @returns {{ provider: string, setProvider: Function, providerOptions: Array<{value: string, label: string}>, loading: boolean }}
 */
export function useProviderOptions(
  initialProvider = "openai",
  initialData?: ProviderOptionsData | null
) {
  const t = useTranslations("translator");
  const [initialOptions] = useState(() =>
    initialData ? buildProviderOptions(initialData, t) : null
  );
  const [provider, setProvider] = useState(
    initialOptions &&
      initialOptions.length > 0 &&
      !initialOptions.some((opt: any) => opt.value === initialProvider)
      ? ((initialOptions[0] as any).value as string)
      : initialProvider
  );
  const [providerOptions, setProviderOptions] = useState<any[]>(initialOptions ?? []);
  const [loading, setLoading] = useState(initialOptions === null);

  useEffect(() => {
    if (initialOptions !== null) return;
    const fetchProviders = async () => {
      try {
        const [connRes, nodesRes] = await Promise.all([
          fetch("/api/providers"),
          fetch("/api/provider-nodes"),
        ]);
        const [connData, nodesData] = await Promise.all([connRes.json(), nodesRes.json()]);
        const nextOptions = buildProviderOptions(
          { connections: connData.connections, nodes: nodesData.nodes },
          t
        );
        setProviderOptions(nextOptions);
        if (nextOptions.length > 0) {
          setProvider((current: string): string =>
            nextOptions.some((opt: any) => opt.value === current)
              ? current
              : ((nextOptions[0] as any).value as string)
          );
        }
      } catch {
        const fallbackOptions = staticProviderOptions();
        setProviderOptions(fallbackOptions);
        if (fallbackOptions.length > 0) {
          setProvider((current) =>
            fallbackOptions.some((opt) => opt.value === current)
              ? current
              : fallbackOptions[0].value
          );
        }
      } finally {
        setLoading(false);
      }
    };
    fetchProviders();
  }, [t, initialOptions]);

  return { provider, setProvider, providerOptions, loading };
}
