import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "use-intl";
import { RadioGroup, RadioGroupItem } from "@omniroute/ui-kit/radio-group";
import { Switch } from "@omniroute/ui-kit/switch";
import { Button, Card, Input } from "@/shared/components";
import Icon from "@/shared/components/Icon";
import type { SkillsProvider } from "@/lib/skills/providerSettings";

type SaveStatus = "" | "saved" | "error";

async function patchSettings(updates: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function SavedBadge({ status, t }: { status: SaveStatus; t: (key: string) => string }) {
  if (status === "saved") {
    return (
      <span className="ml-auto text-xs font-medium text-success flex items-center gap-1">
        <Icon name="check_circle" size={14} /> {t("saved")}
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="ml-auto text-xs font-medium text-error">
        {t("memorySkillsFailedToSave")}
      </span>
    );
  }
  return null;
}

export default function SkillsSettingsTab() {
  const t = useTranslations("settings");
  const [loading, setLoading] = useState(true);
  // chatCore and the skills executor treat a missing value as enabled (`!== false`).
  const [skillsEnabled, setSkillsEnabled] = useState(true);
  const [skillsEnabledSaving, setSkillsEnabledSaving] = useState(false);
  const [skillsEnabledStatus, setSkillsEnabledStatus] = useState<SaveStatus>("");

  const [skillsmpApiKey, setSkillsmpApiKey] = useState("");
  const [skillsmpSaving, setSkillsmpSaving] = useState(false);
  const [skillsmpStatus, setSkillsmpStatus] = useState<SaveStatus>("");
  const [skillsProvider, setSkillsProvider] = useState<SkillsProvider>("skillsmp");
  const [skillsProviderSaving, setSkillsProviderSaving] = useState(false);
  const [skillsProviderStatus, setSkillsProviderStatus] = useState<SaveStatus>("");

  useEffect(() => {
    fetch("/api/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((settingsData) => {
        if (!settingsData) return;
        setSkillsEnabled(settingsData.skillsEnabled !== false);
        if (settingsData.skillsmpApiKey) setSkillsmpApiKey(settingsData.skillsmpApiKey);
        if (
          settingsData.skillsProvider === "skillsmp" ||
          settingsData.skillsProvider === "skillssh"
        ) {
          setSkillsProvider(settingsData.skillsProvider);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const flashSaved = (setStatus: (status: SaveStatus) => void, ok: boolean) => {
    setStatus(ok ? "saved" : "error");
    if (ok) setTimeout(() => setStatus(""), 2000);
  };

  const toggleSkillsEnabled = async () => {
    const previous = skillsEnabled;
    setSkillsEnabled(!previous);
    setSkillsEnabledSaving(true);
    setSkillsEnabledStatus("");
    const ok = await patchSettings({ skillsEnabled: !previous });
    if (!ok) setSkillsEnabled(previous);
    flashSaved(setSkillsEnabledStatus, ok);
    setSkillsEnabledSaving(false);
  };

  const saveSkillsmpApiKey = useCallback(async () => {
    setSkillsmpSaving(true);
    setSkillsmpStatus("");
    flashSaved(setSkillsmpStatus, await patchSettings({ skillsmpApiKey }));
    setSkillsmpSaving(false);
  }, [skillsmpApiKey]);

  const saveSkillsProvider = useCallback(async (provider: SkillsProvider) => {
    setSkillsProvider(provider);
    setSkillsProviderSaving(true);
    setSkillsProviderStatus("");
    flashSaved(setSkillsProviderStatus, await patchSettings({ skillsProvider: provider }));
    setSkillsProviderSaving(false);
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <Card data-testid="skills-settings-card">
        <div className="flex items-center gap-3 mb-5">
          <div className="p-2 rounded-lg bg-bg-subtle text-text-muted">
            <Icon name="handyman" size={20} />
          </div>
          <div>
            <h3 className="text-lg font-semibold">{t("skillsTitle")}</h3>
            <p className="text-sm text-text-muted">{t("skillsDesc")}</p>
          </div>
          <SavedBadge status={skillsEnabledStatus} t={t} />
        </div>

        <div className="flex items-center justify-between p-4 rounded-lg bg-surface/30 border border-border/30">
          <div>
            <p className="text-sm font-medium">{t("skillsEnabled")}</p>
            <p className="text-xs text-text-muted mt-0.5">{t("skillsEnabledDesc")}</p>
          </div>
          <Switch
            data-testid="skills-enabled-switch"
            checked={skillsEnabled}
            onCheckedChange={toggleSkillsEnabled}
            disabled={loading || skillsEnabledSaving}
            aria-checked={skillsEnabled}
            aria-label={t("skillsEnabled")}
          />
        </div>
      </Card>

      {/* SkillsMP Marketplace API Key */}
      <Card>
        <div className="flex items-center gap-3 mb-5">
          <div className="p-2 rounded-lg bg-bg-subtle text-text-muted">
            <Icon name="storefront" size={20} />
          </div>
          <div>
            <h3 className="text-lg font-semibold">{t("memorySkillsSkillsmpMarketplace")}</h3>
            <p className="text-sm text-text-muted">{t("memorySkillsSkillsmpDescription")}</p>
          </div>
          <SavedBadge status={skillsmpStatus} t={t} />
        </div>

        <div className="p-4 rounded-lg bg-surface/30 border border-border/30">
          <div className="flex items-end gap-2">
            <Input
              type="password"
              label={t("memorySkillsApiKey")}
              value={skillsmpApiKey}
              onChange={(e) => setSkillsmpApiKey(e.target.value)}
              placeholder="sk_live_..."
              className="flex-1"
              inputClassName="font-mono"
            />
            <Button variant="primary" onClick={saveSkillsmpApiKey} disabled={skillsmpSaving}>
              {skillsmpSaving ? t("saving") : t("save")}
            </Button>
          </div>
          <p className="text-xs text-text-muted mt-2">
            {t("skillsmpApiKeyHintBefore")} <span className="text-primary">skillsmp.com</span>
            {t("skillsmpApiKeyHintAfter", { limit: 500 })}
          </p>
        </div>
      </Card>

      {/* Active Skills Provider */}
      <Card>
        <div className="flex items-center gap-3 mb-5">
          <div className="p-2 rounded-lg bg-bg-subtle text-text-muted">
            <Icon name="hub" size={20} />
          </div>
          <div>
            <h3 className="text-lg font-semibold">{t("memorySkillsActiveSkillsProvider")}</h3>
            <p className="text-sm text-text-muted">{t("memorySkillsActiveProviderDescription")}</p>
          </div>
          <SavedBadge status={skillsProviderStatus} t={t} />
        </div>

        <RadioGroup
          aria-label={t("memorySkillsActiveSkillsProvider")}
          orientation="horizontal"
          value={skillsProvider}
          onValueChange={(next) => saveSkillsProvider(next as SkillsProvider)}
          disabled={skillsProviderSaving}
        >
          <RadioGroupItem
            card
            value="skillsmp"
            label={t("memorySkillsSkillsmpProviderTitle")}
            description={t("memorySkillsSkillsmpProviderDescription")}
          />
          <RadioGroupItem
            card
            value="skillssh"
            label={t("memorySkillsSkillsshProviderTitle")}
            description={t("memorySkillsSkillsshProviderDescription")}
          />
        </RadioGroup>
      </Card>
    </div>
  );
}
