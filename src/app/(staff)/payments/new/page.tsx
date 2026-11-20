import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PaymentForm } from "@/components/forms/payment-form";
import { Badge, Card, Details, Empty, PageHeader } from "@/components/ui";
import { businessDate } from "@/lib/clock";
import { isUuid } from "@/lib/fields";
import { formatDate, formatShortDate, queryValue } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { formatPhone } from "@/lib/phone";
import { requirePage } from "@/lib/session";
import { backEntryReason } from "@/services/back-entries";
import { operatorsOwingLoans } from "@/services/loans";
import { listOperators } from "@/services/operators";
import { finesOwed, paymentContext, paymentDayStatus } from "@/services/payments";
import { RULE_NAMES } from "@/services/violations";

export async function generateMetadata({ searchParams }: { searchParams: Promise<Record<string, unknown>> }): Promise<Metadata> {
  const kind = queryValue((await searchParams).for);
  return { title: kind === "contribution" ? "Take contribution" : kind === "loan" ? "Take loan repayment" : "Take payment" };
}

const timeFormat = new Intl.DateTimeFormat("en-GB", { hour: "numeric", minute: "2-digit", timeZone: "Africa/Lagos" });
const formatTime = (at: Date) => timeFormat.format(at);

export default async function TakePaymentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, unknown>>;
}) {
  const ctx = await requirePage("payment.record");
  const params = await searchParams;
  const q = queryValue(params.q);
  const operatorId = queryValue(params.operator);
  const forParam = queryValue(params.for);
  const mode = forParam === "balance" ? "old" : forParam === "fines" ? "fine" : forParam === "loan" ? "loan" : null;
  const forContribution = forParam === "contribution";
  // Opened from the operator's page: every back link leads there, not to the operator picker.
  const fromOperator = queryValue(params.from) === "operator";
  const keep = fromOperator ? "&from=operator" : "";

  if (operatorId) {
    const data = isUuid(operatorId) ? await paymentContext(ctx, operatorId) : null;
    if (!data) notFound();
    const { operator, current, balances } = data;
    const today = businessDate(ctx.clock());

    // Weekly contributions are their own money: paid on Sunday, up to 4 weeks ahead.
    if (forContribution) {
      const c = data.contribution;
      const rate = c.rateKobo ?? 0;
      return (
        <>
          <PageHeader
            title={operator.name}
            subtitle={current ? `Tricycle ${current.codeNumber} · Weekly contribution` : "Weekly contribution"}
            back={fromOperator ? { href: `/operators/${operator.id}`, label: operator.name } : { href: `/contributions`, label: "Contributions" }}
            action={operator.status !== "active" ? <Badge tone="bad">{operator.status}</Badge> : undefined}
          />
          <div className="space-y-4">
            <Card title="Weekly contribution" subtitle={c.started ? `${formatNaira(rate)} every Sunday` : undefined}>
              {!c.started ? (
                <p className="text-sm text-muted">Weekly contributions have not started yet. The Manager sets the start Sunday on the Contributions page.</p>
              ) : (
                <>
                  {c.unpaidWeeks.length > 0 ? (
                    <ul className="divide-y divide-line text-sm">
                      {c.unpaidWeeks.map((w) => (
                        <li key={w.chargeId} className="flex items-center justify-between gap-3 py-2">
                          <span className="min-w-0">Sunday {formatDate(w.weekEnding)}</span>
                          <span className="shrink-0 tabular-nums">{formatNaira(w.outstandingKobo)}</span>
                        </li>
                      ))}
                      <li className="flex items-center justify-between gap-3 py-2 font-semibold">
                        <span>Owed</span>
                        <span className="tabular-nums">{formatNaira(c.owedKobo)}</span>
                      </li>
                    </ul>
                  ) : (
                    <p className="text-sm text-muted">
                      Nothing owed.{" "}
                      {c.startsOn && c.startsOn > today
                        ? `The first contribution is due on Sunday ${formatDate(c.startsOn)}.`
                        : "The next contribution is due on Sunday."}
                    </p>
                  )}
                  {c.creditKobo > 0 ? (
                    <p className="mt-3 border-t border-line pt-3 text-sm">
                      Paid ahead: <span className="font-semibold tabular-nums">{formatNaira(c.creditKobo)}</span>
                    </p>
                  ) : null}
                </>
              )}
            </Card>
            {c.started && c.maxKobo > 0 ? (
              <Card title="Take contribution">
                <PaymentForm
                  purpose="contribution"
                  operatorId={operator.id}
                  clientId={randomUUID()}
                  date={today}
                  today={today}
                  leftKobo={c.maxKobo}
                  startKobo={c.owedKobo > 0 ? c.owedKobo : rate}
                  hasTricycle={false}
                />
              </Card>
            ) : c.started ? (
              <p className="rounded-xl border border-line bg-card p-4 text-sm text-ink">
                This operator has already paid 4 weeks ahead.
              </p>
            ) : null}
          </div>
        </>
      );
    }

    // Older days (from the Unpaid page), fines (from Offences) or the loan: each on its own.
    if (mode) {
      const fines = mode === "fine" ? await finesOwed(ctx, operator.id) : [];
      const olderDays = balances.filter((b) => b.businessDate < today);
      const maxKobo =
        mode === "old"
          ? olderDays.reduce((sum, b) => sum + b.outstandingKobo, 0)
          : mode === "fine"
            ? data.penaltiesOwedKobo
            : data.loanOwedKobo;
      const titles = { old: "Older days", fine: "Fines", loan: "Loan" } as const;
      const nothing = {
        old: "Nothing is owed for days before today. Today's balance is taken on the day.",
        fine: "This operator owes no fines.",
        loan: "This operator owes nothing on a loan.",
      } as const;
      return (
        <>
          <PageHeader
            title={operator.name}
            subtitle={current ? `Tricycle ${current.codeNumber} · ${titles[mode]}` : titles[mode]}
            back={{ href: `/payments/new?operator=${operator.id}${keep}`, label: "Today's balance" }}
            action={operator.status !== "active" ? <Badge tone="bad">{operator.status}</Badge> : undefined}
          />
          <div className="space-y-4">
            <Card title={mode === "old" ? "Unpaid earlier days" : mode === "fine" ? "Unpaid fines" : "Loan owed"}>
              {maxKobo === 0 ? (
                <p className="text-sm text-muted">{nothing[mode]}</p>
              ) : mode === "loan" ? (
                <Details rows={[["Left on the loan", formatNaira(data.loanOwedKobo)]]} />
              ) : (
                <ul className="divide-y divide-line text-sm">
                  {(mode === "old"
                    ? olderDays.map((d) => ({ key: d.businessDate, label: formatDate(d.businessDate), amount: d.outstandingKobo }))
                    : fines.map((f) => ({
                        key: f.chargeId,
                        label: `${formatDate(f.occurredOn)} · ${f.ruleCode ? (RULE_NAMES[f.ruleCode] ?? f.ruleCode) : "Fine"}`,
                        amount: f.outstandingKobo,
                      }))
                  ).map((row) => (
                    <li key={row.key} className="flex items-center justify-between gap-3 py-2">
                      <span className="min-w-0">{row.label}</span>
                      <span className="shrink-0 tabular-nums">{formatNaira(row.amount)}</span>
                    </li>
                  ))}
                  <li className="flex items-center justify-between gap-3 py-2 font-semibold">
                    <span>Total</span>
                    <span className="tabular-nums">{formatNaira(maxKobo)}</span>
                  </li>
                </ul>
              )}
            </Card>
            {maxKobo > 0 ? (
              <Card title={mode === "old" ? "Pay older days" : mode === "fine" ? "Pay fines" : "Take loan repayment"}>
                <PaymentForm
                  purpose={mode}
                  operatorId={operator.id}
                  clientId={randomUUID()}
                  date={today}
                  today={today}
                  leftKobo={maxKobo}
                  hasTricycle={false}
                />
              </Card>
            ) : null}
          </div>
        </>
      );
    }

    // One tricycle's balance for one day: today, or an earlier unpaid day for the Manager.
    const canBackdate = can(ctx.actor.role, "payment.backdate");
    const asked = queryValue(params.day);
    const date = canBackdate && asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) && asked < today ? asked : today;
    const [status, lateReason] = await Promise.all([
      paymentDayStatus(ctx, operator.id, date),
      date < today ? backEntryReason(ctx, date) : undefined,
    ]);
    const olderDays = balances.filter((b) => b.businessDate < today);
    const olderKobo = olderDays.reduce((sum, b) => sum + b.outstandingKobo, 0);
    const dayName = date === today ? `Today, ${formatShortDate(date)}` : formatDate(date);
    const state =
      status.dueKobo === null
        ? null
        : status.leftKobo === 0
          ? ({ tone: "good", label: "Paid" } as const)
          : status.paidKobo > 0
            ? ({ tone: "warning", label: "Part paid" } as const)
            : ({ tone: "plain", label: "Not paid" } as const);

    return (
      <>
        <PageHeader
          title={operator.name}
          subtitle={status.tricycleCode ? `Tricycle ${status.tricycleCode}` : "No tricycle"}
          back={fromOperator ? { href: `/operators/${operator.id}`, label: operator.name } : { href: "/payments/new", label: "Choose another operator" }}
          action={operator.status !== "active" ? <Badge tone="bad">{operator.status}</Badge> : undefined}
        />
        <div className="space-y-4">
          <Card
            title={date === today ? "Today's balance" : `Balance for ${formatDate(date)}`}
            action={state ? <Badge tone={state.tone}>{state.label}</Badge> : undefined}
          >
            {status.dueKobo === null ? (
              <p className="text-sm text-muted">
                {status.tricycleCode
                  ? `No balance is due for ${status.tricycleCode} on ${formatDate(date)}.`
                  : `${operator.name} had no tricycle on ${formatDate(date)}, so no balance is due.`}
              </p>
            ) : (
              <>
                <Details
                  rows={[
                    ["Day", dayName],
                    ["Balance", formatNaira(status.dueKobo)],
                    ["Paid", formatNaira(status.paidKobo)],
                    ["Left to pay", formatNaira(status.leftKobo)],
                  ]}
                />
                {status.payments.length > 0 ? (
                  <ul className="mt-3 space-y-1 border-t border-line pt-3 text-sm text-muted">
                    {status.payments.map((p) => (
                      <li key={p.receiptNumber}>
                        {formatNaira(p.amountKobo)} at {formatTime(p.receivedAt)} by {p.receivedBy} · receipt {p.receiptNumber}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
          </Card>

          {status.dueKobo !== null && status.leftKobo > 0 ? (
            <Card title={status.paidKobo > 0 ? "Take the rest" : date === today ? "Take today's balance" : "Take this day's balance"}>
              <PaymentForm
                purpose="day"
                operatorId={operator.id}
                clientId={randomUUID()}
                backdateReason={lateReason}
                date={date}
                today={today}
                leftKobo={status.leftKobo}
                hasTricycle={!!current && current.status !== "off_road"}
              />
            </Card>
          ) : status.dueKobo !== null ? (
            <p className="rounded-xl border border-line bg-card p-4 text-sm text-ink">
              {date === today ? "Today's balance is paid." : "This day is paid."} Each tricycle's balance is taken once a day.
            </p>
          ) : null}

          {data.contribution.owedKobo > 0 ? (
            <Link
              href={`/payments/new?operator=${operator.id}&for=contribution${keep}`}
              className="flex min-h-12 items-center justify-between gap-3 rounded-xl border border-gold/40 bg-gold-wash p-4 text-sm"
            >
              <span>
                <span className="font-semibold">Weekly contribution unpaid</span>
                <span className="block text-muted">
                  {data.contribution.weeksOwed === 1
                    ? `Sunday ${formatDate(data.contribution.oldestWeek!)}`
                    : `${data.contribution.weeksOwed} weeks since Sunday ${formatDate(data.contribution.oldestWeek!)}`}
                </span>
              </span>
              <span className="shrink-0 font-semibold tabular-nums text-gold-deep">
                Collect {formatNaira(data.contribution.owedKobo)}
              </span>
            </Link>
          ) : null}

          {data.loanOwedKobo > 0 ? (
            <Link
              href={`/payments/new?operator=${operator.id}&for=loan${keep}`}
              className="flex min-h-12 items-center justify-between gap-3 rounded-xl border border-gold/40 bg-gold-wash p-4 text-sm"
            >
              <span>
                <span className="font-semibold">Loan unpaid</span>
                <span className="block text-muted">{formatNaira(data.loanOwedKobo)} left to pay back</span>
              </span>
              <span className="shrink-0 font-semibold text-gold-deep">Collect</span>
            </Link>
          ) : null}

          <Card title="Other payments">
            <ul className="divide-y divide-line">
              <li>
                <Link
                  href={`/payments/new?operator=${operator.id}&for=balance${keep}`}
                  className="flex min-h-12 items-center justify-between gap-3 py-2 text-sm hover:text-gold-deep"
                >
                  <span>Older days</span>
                  <span className="tabular-nums text-muted">
                    {olderKobo > 0 ? `${formatNaira(olderKobo)} from ${olderDays.length} day${olderDays.length === 1 ? "" : "s"}` : "Nothing owed"}
                  </span>
                </Link>
              </li>
              {data.penaltiesOwedKobo > 0 ? (
                <li>
                  <Link
                    href={`/payments/new?operator=${operator.id}&for=fines${keep}`}
                    className="flex min-h-12 items-center justify-between gap-3 py-2 text-sm hover:text-gold-deep"
                  >
                    <span>Fines</span>
                    <span className="tabular-nums text-muted">{formatNaira(data.penaltiesOwedKobo)}</span>
                  </Link>
                </li>
              ) : null}
              {data.contribution.started ? (
                <li>
                  <Link
                    href={`/payments/new?operator=${operator.id}&for=contribution${keep}`}
                    className="flex min-h-12 items-center justify-between gap-3 py-2 text-sm hover:text-gold-deep"
                  >
                    <span>Weekly contribution</span>
                    <span className="tabular-nums text-muted">
                      {data.contribution.owedKobo > 0
                        ? `${formatNaira(data.contribution.owedKobo)} from ${data.contribution.weeksOwed} week${data.contribution.weeksOwed === 1 ? "" : "s"}`
                        : data.contribution.creditKobo > 0
                          ? `${formatNaira(data.contribution.creditKobo)} paid ahead`
                          : "Nothing owed"}
                    </span>
                  </Link>
                </li>
              ) : null}
              {data.loanOwedKobo > 0 ? (
                <li>
                  <Link
                    href={`/payments/new?operator=${operator.id}&for=loan${keep}`}
                    className="flex min-h-12 items-center justify-between gap-3 py-2 text-sm hover:text-gold-deep"
                  >
                    <span>Loan</span>
                    <span className="tabular-nums text-muted">{formatNaira(data.loanOwedKobo)}</span>
                  </Link>
                </li>
              ) : null}
            </ul>
            {canBackdate && olderDays.length > 0 ? (
              <div className="mt-3 border-t border-line pt-3">
                <div className="text-sm text-muted">Enter an earlier day&apos;s payment late</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {olderDays.slice(-7).map((d) => (
                    <Link
                      key={d.businessDate}
                      href={`/payments/new?operator=${operator.id}&day=${d.businessDate}${keep}`}
                      aria-current={d.businessDate === date ? "true" : undefined}
                      className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-line bg-card px-3 text-sm hover:bg-card-subtle aria-[current=true]:border-ink"
                    >
                      {formatShortDate(d.businessDate)}
                      <span className="tabular-nums text-muted">{formatNaira(d.outstandingKobo)}</span>
                    </Link>
                  ))}
                  {date !== today ? (
                    <Link
                      href={`/payments/new?operator=${operator.id}${keep}`}
                      className="inline-flex min-h-10 items-center rounded-lg px-3 text-sm underline underline-offset-2"
                    >
                      Back to today
                    </Link>
                  ) : null}
                </div>
              </div>
            ) : null}
          </Card>
        </div>
      </>
    );
  }

  // Loan repayments: everyone who still owes on a loan, with what is left, so no search is needed.
  if (forParam === "loan") {
    const owing = await operatorsOwingLoans(ctx);
    return (
      <>
        <PageHeader
          title="Take loan repayment"
          subtitle={owing.length === 0 ? undefined : `${owing.length} operator${owing.length === 1 ? "" : "s"} owe on a loan`}
          back={{ href: "/loans", label: "Loans" }}
        />
        {owing.length === 0 ? (
          <Empty>No operator owes on a loan.</Empty>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
            {owing.map((o) => (
              <li key={o.operatorId}>
                <Link
                  href={`/payments/new?operator=${o.operatorId}&for=loan`}
                  className="flex min-h-14 items-center justify-between gap-3 p-3 hover:bg-gold-wash"
                >
                  <span className="min-w-0">
                    <span className="block font-bold">{o.name}</span>
                    <span className="block text-sm text-muted">
                      {o.tricycleCode ? `${o.tricycleCode} (${o.registration ?? "no plate"})` : "No tricycle now"} · {formatPhone(o.phone)}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block font-semibold tabular-nums">{formatNaira(o.owedKobo)}</span>
                    <span className="block text-xs text-muted">left</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }

  const results = q?.trim() ? (await listOperators(ctx, { q })).slice(0, 20) : [];
  return (
    <>
      <PageHeader
        title={forContribution ? "Take contribution" : "Take payment"}
        subtitle={forContribution ? "Find the operator paying their weekly contribution" : undefined}
        back={forContribution ? { href: "/contributions", label: "Contributions" } : { href: "/money", label: "Money" }}
      />
      <form className="mb-4 flex gap-2" role="search">
        {forContribution ? <input type="hidden" name="for" value="contribution" /> : null}
        <input
          name="q"
          defaultValue={q}
          autoFocus
          placeholder="Tricycle code, name or phone"
          aria-label="Find operator"
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-card px-3 py-2 text-base"
        />
        <button className="min-h-11 rounded-lg bg-ink px-4 font-semibold text-gold-light">Find</button>
      </form>
      {q?.trim() ? (
        results.length === 0 ? (
          <Empty>No operator found.</Empty>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
            {results.map((o) => (
              <li key={o.id}>
                <Link
                  href={`/payments/new?operator=${o.id}${forContribution ? "&for=contribution" : ""}`}
                  className="block p-3 hover:bg-gold-wash"
                >
                  <div className="font-bold">{o.name}</div>
                  <div className="text-sm text-muted">
                    {o.tricycleCode ?? "No tricycle"} · {formatPhone(o.phone)}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </>
  );
}
