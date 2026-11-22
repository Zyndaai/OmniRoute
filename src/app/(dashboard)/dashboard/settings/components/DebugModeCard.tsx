import { useEffect, useState } from "react";
import { Card, Toggle } from "@/shared/components";
import { useTranslations } from "use-intl";

export default function DebugModeCard({
  initialDebugMode,
}: {
  /** `settings.debugMode` as read by the route loader; undefined: the card fetches it itself. */
  initialDebugMode?: boolean;
} = {}) {
  const [debugMode, setDebugMode] = useState(initialDebugMode ?? true);
  const [loading, setLoading] = useState(initialDebugMode === undefined);
  const t = useTranslations("settings");

  // A new loader result replaces the local value.
  const [shownInitial, setShownInitial] = useState(initialDebugMode);
  if (initialDebugMode !== shownInitial) {
    setShownInitial(initialDebugMode);
    if (initialDebugMode !== undefined) {
      setDebugMode(initialDebugMode);
      setLoading(false);
    }
  }

  useEffect(() => {
    // The route loader already supplied the value.
    if (initialDebugMode !== undefined) return;
    let mounted = true;

    async function loadSettings() {
      setLoading(true);
      try {
        const res = await fetch("/api/settings", { cache: "no-store" });
        if (res.ok && mounted) {
          const data = await res.json();
          setDebugMode(data.debugMode === true);
        }
      } catch {
        // Leave the current switch state in place if settings cannot be loaded.
      } finally {
        if (mounted) setLoading(false);
      }
    }

    loadSettings();
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only fallback fetch
  }, []);

  const updateDebugMode = async (value: boolean) => {
    const previousValue = debugMode;
    setDebugMode(value);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ debugMode: value }),
      });
      if (!res.ok) setDebugMode(previousValue);
    } catch (err) {
      setDebugMode(previousValue);
      console.error("Failed to update debugMode:", err);
    }
  };

  return (
    // Header-only card: the toggle sits in the header action slot, so the header's
    // bottom margin (there is no body below it) is dropped.
    <Card
      icon="bug_report"
      title={t("debugToggle")}
      className="[&>[data-slot=card-header]]:mb-0"
      action={
        <Toggle
          ariaLabel={t("debugToggle")}
          checked={debugMode}
          onChange={updateDebugMode}
          disabled={loading}
        />
      }
    />
  );
}
