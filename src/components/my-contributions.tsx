import { Badge, Card } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import type { getMyContributions } from "@/services/contributions";

type Data = Awaited<ReturnType<typeof getMyContributions>>;

/** The operator's own weekly contributions: this week, what is owed, and past weeks. */
export function MyContributions({ data, today }: { data: Data; today: string }) {
  if (!data.started) return null;
  const rate = data.rateKobo ?? 0;
  const notYet = !!data.startsOn && data.startsOn > today;
  const current = data.current;
  const paid = current && !current.waived && current.paid >= current.amount;
  const status = notYet
    ? { tone: "plain", label: `Starts ${formatDate(data.startsOn!)}` }
    : data.owedKobo > 0
      ? { tone: "bad", label: `${formatNaira(data.owedKobo)} owed` }
      : paid || data.creditKobo > 0
        ? { tone: "good", label: "Paid" }
        : { tone: "gold", label: `${formatNaira(rate)} due Sunday` };
  return (
    <Card
      title="This week's contribution"
      subtitle={`${formatNaira(rate)} every Sunday, paid to the company`}
      action={<Badge tone={status.tone as "good" | "bad" | "gold" | "plain"}>{status.label}</Badge>}
    >
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted">Owed</dt>
          <dd className="font-semibold tabular-nums">{formatNaira(data.owedKobo)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Paid ahead</dt>
          <dd className="font-semibold tabular-nums">{formatNaira(data.creditKobo)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Total contributed</dt>
          <dd className="font-semibold tabular-nums">{formatNaira(data.totalPaidKobo)}</dd>
        </div>
      </dl>
      {data.weeks.length > 0 ? (
        <ul className="mt-3 divide-y divide-line border-t border-line text-sm">
          {data.weeks.slice(0, 8).map((week) => (
            <li key={week.week_ending} className="flex items-center justify-between gap-3 py-2">
              <span>Sunday {formatDate(week.week_ending)}</span>
              <span className="tabular-nums text-muted">
                {week.waived
                  ? "Waived"
                  : week.paid >= week.amount
                    ? `Paid ${formatNaira(week.amount)}`
                    : week.paid > 0
                      ? `${formatNaira(week.amount - week.paid)} left`
                      : `${formatNaira(week.amount)} owed`}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
