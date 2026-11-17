import { PiggyBank } from "lucide-react";
import { StatTile } from "@/components/ui";
import { formatShortDate } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import type { contributionSummary } from "@/services/contributions";

type Summary = NonNullable<Awaited<ReturnType<typeof contributionSummary>>>;

/** This week's contributions collected out of what was charged, for Home and Money. */
export function ContributionTile({ summary, today }: { summary: Summary; today: string }) {
  if (!summary.started) {
    return (
      <StatTile
        label="Weekly contributions"
        value="Not started"
        href="/contributions"
        icon={PiggyBank}
        tone="gold"
        subtext={`First Sunday ${formatShortDate(summary.startsOn)}`}
      />
    );
  }
  const isSunday = summary.week === today;
  return (
    <StatTile
      label={`Contributions, Sunday ${formatShortDate(summary.week)}`}
      value={formatNaira(summary.collectedKobo)}
      href="/contributions?show=unpaid"
      icon={PiggyBank}
      tone={summary.unpaidCount > 0 ? "warning" : "good"}
      subtext={
        isSunday && summary.collectedTodayKobo > 0
          ? `of ${formatNaira(summary.expectedKobo)} · ${formatNaira(summary.collectedTodayKobo)} taken today`
          : `of ${formatNaira(summary.expectedKobo)} · ${summary.unpaidCount} not paid`
      }
    />
  );
}
