import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { issueTricycleAction, markOperatorLeftAction, setOperatorPinAction } from "@/app/actions";
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
import { getOperatorJourney } from "@/services/award-tracker";
import { operatorBalancePeriods } from "@/services/balance-periods";
import { operatorDepositsFor } from "@/services/deposits";
import { getOperator } from "@/services/operators";
import { listInStockTricycles } from "@/services/tricycles";

export const metadata: Metadata = { title: "Operator" };

export default async function OperatorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ balance?: string }>;
}) {
  const ctx = await requirePage("operator.view");
  const { id } = await params;
  const balanceKind = (await searchParams).balance === "month" ? "month" : "week";
  const detail = isUuid(id) ? await getOperator(ctx, id) : null;
  if (!detail) notFound();

  const { operator, history, showSensitive, hasPortalLogin } = detail;
  const canManage = can(ctx.actor.role, "operator.manage");
  const holdsTricycle = history.some((h) => h.assignment.returnedOn === null);
  const canIssue = can(ctx.actor.role, "assignment.manage") && operator.status === "active" && !holdsTricycle;
  const inStock = canIssue ? await listInStockTricycles(ctx) : [];
  const journey = operator.status === "active" ? await getOperatorJourney(ctx, id) : null;
  const seesMoney = can(ctx.actor.role, "finance.view");
  const [deposits, balancePeriods] = seesMoney
    ? await Promise.all([operatorDepositsFor(ctx, id), operatorBalancePeriods(ctx, id)])
    : [null, null];

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
              ["Portal login", hasPortalLogin ? "Set up" : "Not set up"],
            ]}
          />
        </Card>

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
                        <span className="shrink-0 font-semibold tabular-nums">{formatNaira(deposit.amountKobo)}</span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
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
                  <Field name="issuedOn" label="Date issued" type="date" max={businessDate(ctx.clock())} defaultValue={businessDate(ctx.clock())} />
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

        {canManage ? (
          <Disclosure label={hasPortalLogin ? "Reset portal PIN" : "Set up portal login"}>
            <ActionForm action={setOperatorPinAction.bind(null, operator.id)}>
              <Field
                name="pin"
                label="6-digit PIN"
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                maxLength={6}
                hint="The operator logs in with their phone number and this PIN."
              />
              <SubmitButton>Save PIN</SubmitButton>
            </ActionForm>
          </Disclosure>
        ) : null}

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
