import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { NotificationBell } from "@/components/notification-bell";
import { Bell, BellRing, Bike, CalendarDays, CircleHelp, LogOut } from "lucide-react";
import { logoutAction, markNoticesReadAction } from "@/app/actions";
import { ActionForm, SubmitButton } from "@/components/form";
import { OperatorBalanceCard } from "@/components/balance-periods";
import { StatementView } from "@/components/statement";
import { MyAwardJourney } from "@/components/my-awards";
import { MyContributions } from "@/components/my-contributions";
import { Badge, Card, Details, Empty, operatorTone } from "@/components/ui";
import {
  formatDate,
  formatDateTime,
  METHOD_LABELS,
  OPERATOR_STATUS_LABELS,
  WORK_TYPE_LABELS,
} from "@/lib/format";
import { businessDate } from "@/lib/clock";
import { formatPhone } from "@/lib/phone";
import { formatNaira } from "@/lib/money";
import { isStaff } from "@/lib/permissions";
import { requireCtx } from "@/lib/session";
import { myBalancePeriods } from "@/services/balance-periods";
import { getMyRecords } from "@/services/portal";
import { RULE_NAMES } from "@/services/violations";
import { topicFor, topicsFor } from "@/guide";

/** A small "How this works" link on a card, to one of the operator's help topics. */
function HelpLink({ id }: { id: string }) {
  return (
    <Link
      href={`/me/guide/${id}`}
      className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-gold-deep"
    >
      <CircleHelp size={16} aria-hidden /> How this works
    </Link>
  );
}

/** The questions operators ask the office most, first on the Help card. */
const ASKED_MOST = ["my-daily-balance", "my-fines", "my-login"];

export const metadata: Metadata = { title: "Driver Portal" };

type Notice = Awaited<ReturnType<typeof getMyRecords>>["notices"]["items"][number];

function NoticeList({ items }: { items: Notice[] }) {
  return (
    <ul className="divide-y divide-line">
      {items.map((notice) => (
        <li key={notice.id} className="flex items-start gap-2.5 py-2.5 first:pt-0">
          {notice.readAt ? (
            <Bell size={16} aria-hidden className="mt-0.5 shrink-0 text-muted" />
          ) : (
            <BellRing size={16} aria-label="New" className="mt-0.5 shrink-0 text-gold-deep" />
          )}
          <div className="min-w-0">
            <p className={`text-sm leading-snug ${notice.readAt ? "text-ink-muted" : "font-bold text-ink"}`}>{notice.body}</p>
            <p className="mt-0.5 text-xs text-muted">{formatDateTime(notice.createdAt)}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

export default async function MyRecordsPage({ searchParams }: { searchParams: Promise<{ balance?: string }> }) {
  const ctx = await requireCtx();
  if (isStaff(ctx.actor.role)) redirect("/dashboard");
  const balanceKind = (await searchParams).balance === "month" ? "month" : "week";
  const [
    { operator, current, dailyBalanceKobo, statement, compliance, service, journey, honourBoard, runAtRisk, notices, deposits, contributions },
    balancePeriods,
  ] = await Promise.all([getMyRecords(ctx), myBalancePeriods(ctx)]);

  return (
    <main className="mx-auto max-w-lg p-4 pb-[calc(env(safe-area-inset-bottom)+4rem)] sm:p-6">
      {/* Driver Header */}
      <header className="mb-6 flex items-center justify-between gap-3 rounded-2xl border border-line bg-card p-4 shadow-premium">
        <div className="flex min-w-0 items-center gap-3.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/jayngol-mark.svg"
            alt="Jayngol Logo"
            width={44}
            height={44}
            className="shrink-0"
          />
          <div className="min-w-0">
            <h1 className="text-base leading-snug font-semibold text-ink">{operator.name}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              <Badge tone={operatorTone(operator.status)} dot>
                {OPERATOR_STATUS_LABELS[operator.status]}
              </Badge>
              <span className="text-xs text-muted">{formatPhone(operator.phone)}</span>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
        <Link
          href="/me/guide"
          aria-label="Help"
          title="Help"
          className="inline-flex size-11 items-center justify-center rounded-full border border-line bg-card text-ink hover:bg-card-subtle"
        >
          <CircleHelp size={20} aria-hidden />
        </Link>
        <NotificationBell href="/me/notifications" initial={{ unread: notices.unread, critical: notices.critical }} variant="light" />
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
        </div>
      </header>

      <div className="space-y-4">
        {/* Notices */}
        <Card
          title="Notices"
          subtitle={notices.unread > 0 ? `${notices.unread} new` : "You are up to date"}
          action={
            notices.items.length > 0 ? (
              <Link href="/me/notifications" className="inline-flex min-h-11 items-center text-sm font-bold text-gold-deep">
                See all
              </Link>
            ) : undefined
          }
        >
          {notices.items.length === 0 ? (
            <p className="text-sm text-muted">Messages from Jayngol will appear here.</p>
          ) : (
            <>
              {/* New notices always show; otherwise the latest three, so the page stays short on a phone. */}
              <NoticeList items={notices.items.slice(0, Math.max(3, notices.unread))} />
              {notices.items.length > Math.max(3, notices.unread) ? (
                <details className="group mt-2 border-t border-line">
                  <summary className="flex min-h-11 items-center gap-1.5 text-sm font-semibold text-gold-deep">
                    <span className="group-open:hidden">Show {notices.items.length - Math.max(3, notices.unread)} older notices</span>
                    <span className="hidden group-open:inline">Hide older notices</span>
                  </summary>
                  <NoticeList items={notices.items.slice(Math.max(3, notices.unread))} />
                </details>
              ) : null}
            </>
          )}
          {notices.unread > 0 ? (
            <ActionForm action={markNoticesReadAction} className="mt-3">
              <SubmitButton tone="plain">Mark all as read</SubmitButton>
            </ActionForm>
          ) : null}
        </Card>

        <MyAwardJourney progress={journey} board={honourBoard} runAtRisk={runAtRisk} />
        <HelpLink id="my-awards" />

        {/* Tricycle Assignment */}
        {current ? (
          <Card title="Assigned Tricycle" subtitle="Active daily agreement" action={<HelpLink id="my-service" />}>
            <div className="mb-3 flex items-center gap-3 rounded-xl bg-gold-wash/50 p-3 border border-gold-light/40">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gold text-ink font-bold">
                <Bike size={20} />
              </div>
              <div>
                <div className="text-base font-semibold text-ink">{current.codeNumber}</div>
                <div className="text-xs font-semibold text-muted">{current.registrationNumber}</div>
              </div>
            </div>
            <Details
              rows={[
                ["Given to you on", formatDate(current.issuedOn)],
                [
                  "Daily balance",
                  dailyBalanceKobo != null ? formatNaira(dailyBalanceKobo) : "—",
                ],
                [
                  "Next service",
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

        {/* Deposits */}
        {deposits.items.length > 0 ? (
          <Card
            title="My savings"
            subtitle="Held for you by Jayngol and given back at the month end. It does not pay your daily balance."
            action={<HelpLink id="my-savings" />}
          >
            <div className="mb-3 text-2xl font-semibold tabular-nums text-ink">{formatNaira(deposits.heldKobo)}</div>
            <ul className="divide-y divide-line/60">
              {deposits.items.map((deposit) => (
                <li key={deposit.id} className="flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                  <div className="min-w-0 text-sm">
                    <div className="font-bold text-ink">{deposit.receiptNumber}</div>
                    <div className="text-xs text-muted">
                      {formatDate(deposit.businessDate)} · {METHOD_LABELS[deposit.method]}
                    </div>
                  </div>
                  {deposit.reversedAt ? (
                    <Badge tone="bad">Reversed</Badge>
                  ) : (
                    <span className="flex shrink-0 items-center gap-2">
                      {deposit.settlementId ? <Badge tone="plain">Given back</Badge> : null}
                      <span className="text-sm font-bold tabular-nums">{formatNaira(deposit.amountKobo)}</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {deposits.settlements.map((s) => (
              <dl key={s.id} className="mt-3 space-y-1 rounded-xl border border-line bg-card-subtle p-3 text-sm">
                <div className="font-semibold text-ink">Given back on {formatDate(s.businessDate)}</div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">Cleared what you owed</dt>
                  <dd className="tabular-nums">{formatNaira(s.clearedKobo)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">Given back to you</dt>
                  <dd className="tabular-nums">{formatNaira(s.givenBackKobo)}</dd>
                </div>
                {s.keptKobo > 0 ? (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted">Taken off for damage: {s.keptReason}</dt>
                    <dd className="tabular-nums">{formatNaira(s.keptKobo)}</dd>
                  </div>
                ) : null}
                {s.owedFineKobo > 0 ? (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted">Damage still owed, as a fine</dt>
                    <dd className="tabular-nums">{formatNaira(s.owedFineKobo)}</dd>
                  </div>
                ) : null}
              </dl>
            ))}
          </Card>
        ) : null}

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
        <Card title="Offences and fines" subtitle="Recorded rule findings" action={<HelpLink id="my-fines" />}>
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

        {/* Workshop Service History */}
        {service.history.length > 0 ? (
          <Card title="Repairs and servicing" subtitle="Recent depot repairs">
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
        <StatementView
          data={statement}
          afterOwed={
            <div id="my-balance" className="scroll-mt-4">
              <OperatorBalanceCard
                title="My balance"
                periods={balancePeriods}
                kind={balanceKind}
                hrefFor={(kind) => (kind === "week" ? "/me#my-balance" : `/me?balance=${kind}#my-balance`)}
              />
              {contributions.started ? (
                <div className="mt-4">
                  <MyContributions data={contributions} today={businessDate(ctx.clock())} />
                </div>
              ) : null}
            </div>
          }
        />

        {/* Help */}
        {topicsFor(ctx.actor.role).length > 0 ? (
          <Card title="Help" subtitle="Answers to what operators ask most">
            <ul className="divide-y divide-line">
              {ASKED_MOST.map((id) => topicFor(ctx.actor.role, id))
                .filter((topic) => topic !== null)
                .map((topic) => (
                  <li key={topic.id}>
                    <Link href={`/me/guide/${topic.id}`} className="flex min-h-12 items-center justify-between gap-3 py-2 font-semibold text-ink">
                      {topic.title} <span aria-hidden className="text-gold-deep">→</span>
                    </Link>
                  </li>
                ))}
            </ul>
            <Link href="/me/guide" className="mt-2 inline-flex min-h-11 items-center text-sm font-bold text-gold-deep">
              All help
            </Link>
          </Card>
        ) : null}
      </div>
    </main>
  );
}
