import { useTranslations } from "use-intl";
import { useTheme } from "@/shared/hooks/useTheme";

export function TierFlowDiagram() {
  const t = useTranslations("onboarding.tier");
  const tOnboarding = useTranslations("onboarding");
  const { isDark } = useTheme();
  const src = isDark ? "/images/tier-flow-dark.svg" : "/images/tier-flow-light.svg";

  return (
    <div className="flex flex-col items-center gap-3 my-4">
      <img
        src={src}
        alt={tOnboarding("tierFlowDiagramAlt")}
        width={800}
        height={420}
        className="w-full max-w-2xl rounded-lg border border-border"
      />
      <p className="mx-auto max-w-md text-xs leading-relaxed text-text-muted text-center text-balance">
        {t("flowCaption")}
      </p>
    </div>
  );
}
