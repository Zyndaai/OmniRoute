import { useCallback, useState } from "react";
import { useTranslations } from "use-intl";
import { Toggle } from "@/shared/components";

type FlagEntry = { key: string; effectiveValue: string };

const CODEX_KEY = "OMNIROUTE_AUTO_SYNC_CODEX_PROFILES";
const CLAUDE_KEY = "OMNIROUTE_AUTO_SYNC_CLAUDE_PROFILES";

function isOn(value: string | undefined): boolean {
  return value === "true" || value === "1" || value === "yes" || value === "on";
}

/**
 * Toggle card for the opt-in "auto-sync CLI profiles after model discovery" feature.
 * Reads/writes the OMNIROUTE_AUTO_SYNC_{CODEX,CLAUDE}_PROFILES feature flags via
 * /api/settings/feature-flags. Both default off; enabling one makes a provider model
 * sync regenerate that tool's profile files from the live catalog.
 */
/** The two flags and the load error, as the route loader reads them. */
export interface ProfileSyncState {
  codex: boolean;
  claude: boolean;
  /** "HTTP <status>" when the flags could not be read. */
  error: string | null;
}

/** Reads the two auto-sync flags out of the `/api/settings/feature-flags` body. */
export function profileSyncFromFlags(body: { flags?: unknown } | null): {
  codex: boolean;
  claude: boolean;
} {
  const flags: FlagEntry[] = Array.isArray(body?.flags) ? (body.flags as FlagEntry[]) : [];
  return {
    codex: isOn(flags.find((f) => f.key === CODEX_KEY)?.effectiveValue),
    claude: isOn(flags.find((f) => f.key === CLAUDE_KEY)?.effectiveValue),
  };
}

export default function CliProfileAutoSyncToggles({ initial }: { initial: ProfileSyncState }) {
  const t = useTranslations("cliTools");
  const [codexOn, setCodexOn] = useState(initial.codex);
  const [claudeOn, setClaudeOn] = useState(initial.claude);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(initial.error);
  // Edits are local (optimistic); a new loader result replaces them.
  const [shownInitial, setShownInitial] = useState(initial);
  if (initial !== shownInitial) {
    setShownInitial(initial);
    setCodexOn(initial.codex);
    setClaudeOn(initial.claude);
    setError(initial.error);
  }

  const persist = useCallback(
    async (key: string, next: boolean, previous: boolean, apply: (v: boolean) => void) => {
      apply(next); // optimistic
      setSavingKey(key);
      setError(null);
      try {
        const res = await fetch("/api/settings/feature-flags", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key, value: next ? "true" : "false" }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (err) {
        apply(previous); // revert on failure
        setError(err instanceof Error ? err.message : t("failedSave"));
      } finally {
        setSavingKey(null);
      }
    },
    [t]
  );

  return (
    <div className="rounded-xl border border-border bg-surface/40 p-4">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-text-main">{t("profileSyncTitle")}</h3>
        <p className="text-xs text-text-muted">{t("profileSyncDescription")}</p>
      </div>
      <div className="flex flex-col gap-3">
        <Toggle
          checked={codexOn}
          disabled={savingKey === CODEX_KEY}
          onChange={(v) => persist(CODEX_KEY, v, codexOn, setCodexOn)}
          label={t("codexProfiles")}
          description={t("codexProfilesDescription")}
        />
        <Toggle
          checked={claudeOn}
          disabled={savingKey === CLAUDE_KEY}
          onChange={(v) => persist(CLAUDE_KEY, v, claudeOn, setClaudeOn)}
          label={t("claudeProfiles")}
          description={t("claudeProfilesDescription")}
        />
      </div>
      {error ? <p className="mt-2 text-xs text-error">{error}</p> : null}
    </div>
  );
}
