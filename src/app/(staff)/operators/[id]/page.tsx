import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { issueTricycleAction, markOperatorLeftAction, setOperatorPinAction, undoSettlementAction } from "@/app/actions";
import { DepositSettleForm } from "@/components/forms/deposit-settle-form";
import { AwardJourneyCard } from "@/components/award-tracker";
import { OperatorBalanceCard } from "@/components/balance-periods";
import { ActionForm, Field, SelectField, SubmitButton, TextareaField } from "@/components/form";
import { Badge, Card, Details, Disclosure, Empty, LinkButton, operatorTone, PageHeader } from "@/components/ui";
import { businessDate } from "@/lib/clock";
import { isUuid } from "@/lib/fields";
import { CLOSED_REASON_LABELS, formatDate, METHOD_LABELS, OPERATOR_STATUS_LABELS } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { formatPhone } from "@/lib/phone";
import { tricycleOptionLabel } from "@/lib/tricycle-option";
import { requirePage } from "@/lib/session";
import { IssueDateField } from "@/components/forms/issue-date-field";
import { lastJobDate } from "@/services/daily-job";
import { getOperatorJourney } from "@/services/award-tracker";
import { operatorBalancePeriods } from "@/services/balance-periods";
import { operatorDepositsFor } from "@/services/deposits";
import { depositPosition } from "@/services/deposit-settlements";
import { moneySources } from "@/services/cash-book";
import { activeLoanFor } from "@/services/loans";
import { getOperator } from "@/services/operators";
import { listInStockTricycles } from "@/services/tricycles";

export const metadata: Metadata = { title: "Operator" };

export default async function OperatorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ balance?: string; login?: string }>;
}) {
  const ctx = await requirePage("operator.view");
  const { id } = await params;
  const balanceKind = (await searchParams).balance === "month" ? "month" : "week";
  const detail = isUuid(id) ? await getOperator(ctx, id) : null;
  if (!detail) notFound();

  const { operator, history, showSensitive, hasPortalLogin } = detail;
  const canManage = can(ctx.actor.role, "operator.manage");
  const working = operator.status === "active";
  const canLogin = canManage && working;
  const openLogin = (await searchParams).login === "1";
  const loginHref = `/operators/${id}?login=1#portal-login`;
  const portalLogin = !working ? (
      hasPortalLogin ? "Stopped, no longer working" : "Not set up"
    ) : (
      <span className="inline-flex flex-wrap justify-end gap-x-2">
        <span>{hasPortalLogin ? "Set up" : "Not set up"}</span>
        {canLogin ? (
          <Link href={loginHref} className="font-semibold text-gold-deep underline">
            {hasPortalLogin ? "Reset PIN" : "Set up login"}
          </Link>
        ) : null}
      </span>
    );
  const holdsTricycle = history.some((h) => h.assignment.returnedOn === null);
  const canIssue = can(ctx.actor.role, "assignment.manage") && operator.status === "active" && !holdsTricycle;
  const inStock = canIssue ? await listInStockTricycles(ctx) : [];
  const journey = operator.status === "active" ? await getOperatorJourney(ctx, id) : null;
  const seesMoney = can(ctx.actor.role, "finance.view");
  const [deposits, balancePeriods, loan, position] = seesMoney
    ? await Promise.all([
        operatorDepositsFor(ctx, id),
        operatorBalancePeriods(ctx, id),
        activeLoanFor(ctx, id),
        depositPosition(ctx, id),
      ])
    : [null, null, null, null];
  const settleNow = position && position.canSettle && position.heldKobo > 0 && !position.notYet;
  const sources = settleNow ? await moneySources(ctx) : [];
  const today = businessDate(ctx.clock());

  return (
    <>
      <PageHeader
        title={operator.name}
        subtitle={formatPhone(operator.phone)}
        back={{ href: "/operators", label: "Operators" }}
        action={
          <div className="flex items-center gap-2">
            <Badge tone={operatorTone(operator.status)}>{OPERATOR_STATUS_LABELS[operator.status]}</Badge>
            {canManage ? <LinkButton href={`/operators/${id}/edit`}>Edit</LinkButton> : null}
          </div>
        }
      />
      <div className="space-y-4">
        <Card title="Details">
          <Details
            rows={[
              ["Licence number", operator.licenceNumber],
              ...(showSensitive
                ? ([
                    ["Address", operator.address],
                    ["Guarantor", operator.guarantorName],
                    ["Guarantor phone", operator.guarantorPhone ? formatPhone(operator.guarantorPhone) : null],
                    ["Guarantor address", operator.guarantorAddress],
                  ] as [string, string | null][])
                : []),
              ["Portal login", portalLogin],
            ]}
          />
        </Card>

        {canLogin ? (
          <div id="portal-login" className="scroll-mt-20">
            <Disclosure label={hasPortalLogin ? "Reset portal PIN" : "Set up portal login"} open={openLogin}>
              <ActionForm action={setOperatorPinAction.bind(null, operator.id)}>
                <Field
                  name="pin"
                  label={hasPortalLogin ? "New 6-digit PIN" : "6-digit PIN"}
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  maxLength={6}
                  hint={
                    hasPortalLogin
                      ? "The operator logs in with their phone number and this PIN. Saving signs them out everywhere."
                      : "The operator logs in with their phone number and this PIN. Tell them the PIN in person."
                  }
                />
                <SubmitButton>Save PIN</SubmitButton>
              </ActionForm>
            </Disclosure>
          </div>
        ) : null}

        {balancePeriods ? (
          <div id="balance" className="scroll-mt-20">
            <OperatorBalanceCard
              title="Balance this week and month"
              periods={balancePeriods}
              kind={balanceKind}
              hrefFor={(kind) => (kind === "week" ? `/operators/${id}#balance` : `/operators/${id}?balance=${kind}#balance`)}
            />
          </div>
        ) : null}
        {journey ? <AwardJourneyCard operatorId={id} progress={journey.progress} /> : null}

        {loan ? (
          <Card
            title="Loan"
            subtitle={`${formatNaira(loan.principalKobo)} given ${formatDate(loan.disbursedOn)}`}
            action={
              can(ctx.actor.role, "payment.record") ? (
                <LinkButton href={`/payments/new?operator=${id}&for=loan`} variant="gold">
                  Take loan repayment
                </LinkButton>
              ) : undefined
            }
          >
            <Link href={`/loans/${loan.id}`} className="flex min-h-11 items-center justify-between gap-3 hover:text-gold-deep">
              <span className="text-sm text-muted">
                {loan.repaidKobo > 0 ? `${formatNaira(loan.repaidKobo)} paid back` : "Nothing paid back yet"}
              </span>
              <span className="font-semibold tabular-nums">{formatNaira(loan.owedKobo)} left</span>
            </Link>
          </Card>
        ) : null}

        {deposits ? (
          <Card
            title="Deposit"
            subtitle={`Held for this operator: ${formatNaira(deposits.heldKobo)}`}
            action={
              operator.status === "active" && can(ctx.actor.role, "payment.record") ? (
                <LinkButton href={`/deposits/new?operator=${id}`}>Record deposit</LinkButton>
              ) : undefined
            }
          >
            {deposits.items.length === 0 ? (
              <p className="text-sm text-muted">No deposit recorded yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {deposits.items.map((deposit) => (
                  <li key={deposit.id}>
                    <Link href={`/deposits/${deposit.id}`} className="flex min-h-11 items-center justify-between gap-3 py-2 hover:text-gold-deep">
                      <span className="min-w-0 text-sm">
                        {deposit.receiptNumber} · {METHOD_LABELS[deposit.method]} · {formatDate(deposit.businessDate)}
                      </span>
                      {deposit.reversedAt ? (
                        <Badge tone="bad">Reversed</Badge>
                      ) : (
                        <span className="flex shrink-0 items-center gap-2">
                          {deposit.settlementId ? <Badge tone="plain">Settled</Badge> : null}
                          <span className="font-semibold tabular-nums">{formatNaira(deposit.amountKobo)}</span>
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {position && position.heldKobo > 0 && position.notYet && !working ? (
              <p className="mt-3 text-sm text-muted">{position.notYet}</p>
            ) : null}
          </Card>
        ) : null}

        {settleNow ? (
          <div id="deposit" className="scroll-mt-24">
            <Card title="Settle deposit" subtitle="Clear what is owed from the deposit and give the rest back.">
              <DepositSettleForm operatorId={operator.id} heldKobo={position.heldKobo} owed={position.owed} sources={sources} />
            </Card>
          </div>
        ) : null}

        {position && position.settlements.length > 0 ? (
          <Card title="Deposit settlements">
            <ul className="divide-y divide-line">
              {position.settlements.map((s) => (
                <li key={s.id} className="space-y-1 py-3 first:pt-0 last:pb-0">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-semibold">
                      {formatDate(s.businessDate)} · {formatNaira(s.heldKobo)} held
                    </span>
                    {s.undoneAt ? (
                      <Badge tone="bad">Undone</Badge>
                    ) : s.keptKobo > 0 ? (
                      <Badge tone="warning">Partly kept</Badge>
                    ) : (
                      <Badge tone="good">Settled</Badge>
                    )}
                  </div>
                  <dl className="grid gap-x-4 text-sm sm:grid-cols-3">
                    <div className="flex justify-between gap-2 sm:block">
                      <dt className="text-muted">Cleared debts</dt>
                      <dd className="tabular-nums">
                        {formatNaira(s.clearedKobo)}
                        {s.paymentId && s.receiptNumber ? (
                          <Link href={`/payments/${s.paymentId}`} className="ml-1 text-gold-deep underline">
                            {s.receiptNumber}
                          </Link>
                        ) : null}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2 sm:block">
                      <dt className="text-muted">Given back</dt>
                      <dd className="tabular-nums">
                        {formatNaira(s.givenBackKobo)}
                        {s.givenBackKobo > 0 ? (
                          <span className="text-muted">
                            {" "}from {s.custodianName ? `${s.custodianName}'s cash` : "the bank"}
                            {s.reference ? ` · ${s.reference}` : ""}
                          </span>
                        ) : null}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2 sm:block">
                      <dt className="text-muted">Kept</dt>
                      <dd className="tabular-nums">{formatNaira(s.keptKobo)}</dd>
                    </div>
                  </dl>
                  {s.keptReason ? <p className="text-sm text-muted">Kept because: {s.keptReason}</p> : null}
                  {!s.undoneAt && s.businessDate === today && position.canSettle ? (
                    <ActionForm action={undoSettlementAction.bind(null, s.id)} className="pt-1">
                      <SubmitButton tone="plain">Undo settlement</SubmitButton>
                    </ActionForm>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {can(ctx.actor.role, "finance.view") ? (
          <div className="flex flex-wrap gap-2">
            <LinkButton href={`/operators/${id}/statement`}>View statement</LinkButton>
            {can(ctx.actor.role, "payment.record") ? (
              <LinkButton href={`/payments/new?operator=${id}`}>Take payment</LinkButton>
            ) : null}
          </div>
        ) : null}

        {canIssue ? (
          <Card title="Issue a tricycle">
            {inStock.length === 0 ? (
              <p className="text-muted">No tricycle is in stock right now.</p>
            ) : (
              <ActionForm action={issueTricycleAction}>
                <input type="hidden" name="operatorId" value={operator.id} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <SelectField name="tricycleId" label="Tricycle" defaultValue="">
                    <option value="" disabled>Choose…</option>
                    {inStock.map((t) => (
                      <option key={t.id} value={t.id} disabled={t.dailyBalanceKobo == null}>{tricycleOptionLabel(t)}</option>
                    ))}
                  </SelectField>
                  <IssueDateField today={businessDate(ctx.clock())} lastJobDate={await lastJobDate()} />
                </div>
                <SubmitButton>Issue tricycle</SubmitButton>
              </ActionForm>
            )}
          </Card>
        ) : null}

        <Card title="Tricycle history">
          {history.length === 0 ? (
            <Empty>No tricycle has been issued to this operator.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {history.map((h) => (
                <li key={h.assignment.id} className="py-2">
                  <Link href={`/tricycles/${h.assignment.tricycleId}`} className="font-semibold text-gold-deep underline">
                    {h.codeNumber}
                  </Link>{" "}
                  <span className="text-muted">· {h.registrationNumber}</span>
                  <div className="text-sm text-muted">
                    Issued {formatDate(h.assignment.issuedOn)}
                    {h.assignment.returnedOn ? ` · Returned ${formatDate(h.assignment.returnedOn)}` : " · Current"}
                    {h.assignment.returnReason ? ` · ${CLOSED_REASON_LABELS[h.assignment.returnReason]}` : ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>


        {canManage && operator.status === "active" && !holdsTricycle ? (
          <Disclosure label="Mark as left">
            <ActionForm action={markOperatorLeftAction.bind(null, operator.id)}>
              <TextareaField name="reason" label="Reason" />
              <SubmitButton>Confirm operator left</SubmitButton>
            </ActionForm>
          </Disclosure>
        ) : null}
      </div>
    </>
  );
}
