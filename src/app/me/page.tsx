import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Award, Bike, CalendarDays, LogOut, ShieldAlert, Wrench } from "lucide-react";
import { logoutAction } from "@/app/actions";
import { StatementView } from "@/components/statement";
import { Badge, Card, Details, Empty, operatorTone } from "@/components/ui";
import {
  AWARD_LABELS,
  AWARD_PRIZES,
  formatDate,
  formatDateTime,
  OPERATOR_STATUS_LABELS,
  WORK_TYPE_LABELS,
} from "@/lib/format";
import { businessDate } from "@/lib/clock";
import { formatPhone } from "@/lib/phone";
import { formatNaira } from "@/lib/money";
import { isStaff } from "@/lib/permissions";
import { requireCtx } from "@/lib/session";
import { getMyRecords } from "@/services/portal";
import { RULE_NAMES } from "@/services/violations";

export const metadata: Metadata = { title: "Driver Portal" };

export default async function MyRecordsPage() {
  const ctx = await requireCtx();
  if (isStaff(ctx.actor.role)) redirect("/dashboard");
  const { operator, current, dailyBalanceKobo, statement, compliance, service, awards } =
    await getMyRecords(ctx);

  return (
    <div className="mx-auto max-w-lg p-4 sm:p-6 pb-24">
      {/* Driver Header */}
      <header className="mb-6 flex items-center justify-between gap-3 rounded-2xl border border-line bg-card p-4 shadow-premium">
        <div className="flex min-w-0 items-center gap-3.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/jayngol-mark.svg"
            alt="Jayngol Logo"
            width={44}
            height={44}
            className="shrink-0 drop-shadow-sm"
          />
          <div className="min-w-0">
            <h1 className="truncate text-base font-extrabold text-ink">{operator.name}</h1>
            <div className="mt-0.5 flex items-center gap-2">
              <Badge tone={operatorTone(operator.status)} dot>
                {OPERATOR_STATUS_LABELS[operator.status]}
              </Badge>
              <span className="text-xs text-muted">{formatPhone(operator.phone)}</span>
            </div>
          </div>
        </div>

        <form action={logoutAction}>
          <button
            type="submit"
            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-line bg-card-subtle px-3.5 text-xs font-bold text-muted transition-colors hover:bg-danger-wash hover:text-danger active:scale-95"
            aria-label="Log out"
          >
            <LogOut size={16} />
            <span className="hidden sm:inline">Log out</span>
          </button>
        </form>
      </header>

      <div className="space-y-4">
        {/* Tricycle Assignment */}
        {current ? (
          <Card title="Assigned Tricycle" subtitle="Active daily agreement">
            <div className="mb-3 flex items-center gap-3 rounded-xl bg-gold-wash/50 p-3 border border-gold-light/40">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gold text-ink font-bold">
                <Bike size={20} />
              </div>
              <div>
                <div className="text-base font-black text-ink">{current.codeNumber}</div>
                <div className="text-xs font-semibold text-muted">{current.registrationNumber}</div>
              </div>
            </div>
            <Details
              rows={[
                ["Issued Date", formatDate(current.issuedOn)],
                [
                  "Daily Hire Rate",
                  dailyBalanceKobo != null ? formatNaira(dailyBalanceKobo) : "—",
                ],
                [
                  "Next Depot Service",
                  service.nextService
                    ? `${formatDate(service.nextService)}, 8:00 to 10:00 am`
                    : "Up to date",
                ],
              ]}
            />
          </Card>
        ) : (
          <Empty>You do not have a tricycle assigned at the moment.</Empty>
        )}

        {/* Upcoming Meetings */}
        {compliance.upcoming.length > 0 ? (
          <Card title="Upcoming Meetings" subtitle="Mandatory fleet briefing">
            <ul className="space-y-2.5">
              {compliance.upcoming.map((meeting) => (
                <li
                  key={meeting.id}
                  className="rounded-xl border border-line bg-card-subtle p-3 text-sm"
                >
                  <div className="flex items-center gap-2 font-bold text-ink">
                    <CalendarDays size={16} className="text-gold-deep" />
                    <span>{meeting.title}</span>
                  </div>
                  <div className="mt-1 text-xs text-muted">
                    {formatDateTime(meeting.scheduledFor)} • Please arrive with your tricycle.
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {/* Rule Offences */}
        <Card title="Compliance & Fines" subtitle="Recorded rule findings">
          {compliance.offences.length === 0 ? (
            <div className="py-2 text-center text-xs font-semibold text-ok">
              ✨ Excellent record! You have zero recorded rule violations.
            </div>
          ) : (
            <ul className="divide-y divide-line/60">
              {compliance.offences.map((offence) => (
                <li key={offence.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-bold text-sm text-ink">
                        {RULE_NAMES[offence.ruleCode] ?? offence.ruleCode}
                      </div>
                      <div className="text-xs text-muted mt-0.5">
                        {formatDate(offence.occurredOn)}
                        {offence.tricycleCode ? ` · ${offence.tricycleCode}` : ""} ·{" "}
                        <strong className="text-danger">{formatNaira(offence.amountKobo)}</strong>
                      </div>
                      {offence.status === "waived" && offence.decisionReason ? (
                        <div className="mt-1 rounded-md bg-ok-wash px-2 py-0.5 text-xs text-ok font-medium">
                          Waived: {offence.decisionReason}
                        </div>
                      ) : null}
                      {offence.photoId ? (
                        <a
                          href={`/api/photos/${offence.photoId}`}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1.5 inline-flex min-h-11 items-center text-xs font-bold text-gold-deep underline hover:text-gold"
                        >
                          View evidence photo →
                        </a>
                      ) : null}
                    </div>
                    <Badge tone={offence.status === "waived" ? "plain" : "bad"} dot>
                      {offence.status === "waived" ? "Waived" : "Fined"}
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Award Progress */}
        <Card title="Driver Excellence Bonus" subtitle="Quarterly incentive progress">
          <ul className="divide-y divide-line/60">
            {awards.map((award) => (
              <li key={award.type} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-bold text-sm text-ink">
                    {AWARD_LABELS[award.type]}{" "}
                    <span className="font-normal text-xs text-muted">
                      ({AWARD_PRIZES[award.type]})
                    </span>
                  </div>
                  <Badge tone={award.blockers.length === 0 ? "good" : "gold"} dot>
                    {award.blockers.length === 0 ? "On Track" : "Not Yet"}
                  </Badge>
                </div>
                {award.blockers.map((blocker) => (
                  <p key={blocker} className="mt-1 text-xs text-muted">
                    • {blocker}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        </Card>

        {/* Workshop Service History */}
        {service.history.length > 0 ? (
          <Card title="Service & Maintenance History" subtitle="Recent depot repairs">
            <ul className="divide-y divide-line/60">
              {service.history.map((work) => (
                <li key={work.id} className="flex justify-between gap-3 py-2 text-xs">
                  <span className="font-bold text-ink">{WORK_TYPE_LABELS[work.type]}</span>
                  <span className="text-muted">
                    {work.completedAt ? formatDate(businessDate(work.completedAt)) : "In progress"}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {/* Financial Statement */}
        <StatementView data={statement} />
      </div>
    </div>
  );
}
