import { useTranslation } from "react-i18next";
import type { PrSummary } from "../lib/types";

const CHECK_ICON = { success: "✓", failure: "✕", pending: "●", none: "" } as const;

export function PrBadge({ summary, compact = false }: { summary: PrSummary; compact?: boolean }) {
  const { t } = useTranslation();
  const { pr, checks } = summary;
  const status = pr.state === "OPEN" ? (pr.isDraft ? "draft" : "open") : pr.state.toLowerCase();

  return (
    <span
      className={`pr-badge pr-${status} checks-${checks.state}`}
      title={t("pr.tooltip", {
        number: pr.number,
        title: pr.title,
        status: t(`pr.status.${status}`),
        passed: checks.passed,
        failed: checks.failed,
        pending: checks.pending,
      })}
    >
      #{pr.number}
      {checks.state !== "none" && <span className="pr-checks">{CHECK_ICON[checks.state]}</span>}
      {!compact && <span className="pr-status">{t(`pr.status.${status}`)}</span>}
    </span>
  );
}
