import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  changeRateAction,
  issueTricycleAction,
  retireTricycleAction,
  returnTricycleAction,
} from "@/app/actions";
import { ActionForm, Field, SelectField, SubmitButton, TextareaField } from "@/components/form";
import { Badge, Card, Details, Disclosure, Empty, LinkButton, PageHeader, tricycleTone } from "@/components/ui";
import { businessDate } from "@/lib/clock";
import { isUuid } from "@/lib/fields";
import {
  BALANCE_HINT,
  CLOSED_REASON_LABELS,
  formatDate,
  RETURN_REASON_LABELS,
  SERVICE_LABELS,
  TRICYCLE_STATUS_LABELS,
  WORK_STATUS_LABELS,
  WORK_TYPE_LABELS,
} from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { formatPhone } from "@/lib/phone";
import { formatQuantity } from "@/lib/quantity";
import { requirePage } from "@/lib/session";
import { listAvailableOperators } from "@/services/operators";
import { getTricycle } from "@/services/tricycles";
import { tricycleWorkHistory } from "@/services/workshop";

export const metadata: Metadata = { title: "Tricycle" };


export default async function TricyclePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePage("tricycle.view");
  const { id } = await params;
  const detail = isUuid(id) ? await getTricycle(ctx, id) : null;
  if (!detail) notFound();

  const { tricycle, current, history } = detail;
  const today = businessDate(ctx.clock());
  const canManage = can(ctx.actor.role, "assignment.manage");
  const canIssue = canManage && tricycle.status === "in_stock";
  const available = canIssue ? await listAvailableOperators(ctx) : [];
  const work = await tricycleWorkHistory(ctx, id);

  return (
    <>
      <PageHeader
        title={tricycle.codeNumber}
        subtitle={tricycle.registrationNumber}
        back={{ href: "/tricycles", label: "Tricycles" }}
        action={
          <div className="flex items-center gap-2">
            <Badge tone={tricycleTone(tricycle.status)}>{TRICYCLE_STATUS_LABELS[tricycle.status]}</Badge>
            {can(ctx.actor.role, "tricycle.manage") ? <LinkButton href={`/tricycles/${id}/edit`}>Edit</LinkButton> : null}
          </div>
        }
      />
      <div className="space-y-4">
        {current ? (
          <Card title="Current operator">
            <Details
              rows={[
                ["Operator", <Link key="o" href={`/operators/${current.assignment.operatorId}`} className="text-gold-deep underline">{current.operatorName}</Link>],
                ["Date issued", formatDate(current.assignment.issuedOn)],
                ["Daily balance", current.dailyBalanceKobo != null ? formatNaira(current.dailyBalanceKobo) : "—"],
              ]}
            />
            {current.rates.length > 1 ? (
              <ul className="mt-2 text-sm text-muted">
                {current.rates.map((r) => (
                  <li key={r.id}>{formatNaira(r.amountKobo)} from {formatDate(r.effectiveFrom)}</li>
                ))}
              </ul>
            ) : null}
          </Card>
        ) : null}

        {canIssue ? (
          <Card title="Issue to an operator">
            {available.length === 0 ? (
              <p className="text-muted">
                No active operator is free. <Link href="/operators/new" className="text-gold-deep underline">Add an operator</Link> first.
              </p>
            ) : (
              <ActionForm action={issueTricycleAction}>
                <input type="hidden" name="tricycleId" value={tricycle.id} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <SelectField name="operatorId" label="Operator" defaultValue="">
                    <option value="" disabled>Choose…</option>
                    {available.map((o) => (
                      <option key={o.id} value={o.id}>{o.name} ({formatPhone(o.phone)})</option>
                    ))}
                  </SelectField>
                  <Field name="issuedOn" label="Date issued" type="date" max={today} defaultValue={today} />
                  <Field name="dailyBalance" label="Daily balance (₦)" inputMode="decimal" hint={BALANCE_HINT} />
                </div>
                <SubmitButton>Issue tricycle</SubmitButton>
              </ActionForm>
            )}
          </Card>
        ) : null}

        <Card title="Details">
          <Details
            rows={[
              ["Date purchased", formatDate(tricycle.purchasedOn)],
              ["Purchase cost", tricycle.purchaseCostKobo != null ? formatNaira(tricycle.purchaseCostKobo) : null],
              ["Chassis number", tricycle.chassisNumber],
              ["Engine number", tricycle.engineNumber],
              ["Service cycle", SERVICE_LABELS[tricycle.serviceInterval]],
              ["Cycle start", formatDate(tricycle.serviceCycleStart)],
              ...(tricycle.status === "issued" || tricycle.status === "off_road"
                ? ([["Next service", work.nextService ? formatDate(work.nextService) : "—"]] as [string, string][])
                : []),
              ...(tricycle.retiredReason ? ([["Retired because", tricycle.retiredReason]] as [string, string][]) : []),
            ]}
          />
        </Card>

        <Card title="Operator history">
          {history.length === 0 ? (
            <Empty>This tricycle has not been issued yet.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {history.map(({ assignment: a, operatorName }) => (
                <li key={a.id} className="py-2">
                  <Link href={`/operators/${a.operatorId}`} className="font-semibold text-gold-deep underline">{operatorName}</Link>
                  <div className="text-sm text-muted">
                    Issued {formatDate(a.issuedOn)}
                    {a.returnedOn ? ` · Returned ${formatDate(a.returnedOn)}` : " · Current"}
                    {a.returnReason ? ` · ${CLOSED_REASON_LABELS[a.returnReason]}` : ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Service and repairs">
          {work.showCost && work.orders.length > 0 ? (
            <div className="mb-3">
              <div className="text-2xl font-bold">{formatNaira(work.partsKobo + work.labourKobo)}</div>
              <div className="text-sm text-muted">
                Spent on this tricycle: {formatNaira(work.partsKobo)} parts, {formatNaira(work.labourKobo)} labour
              </div>
            </div>
          ) : null}
          {work.orders.length === 0 ? (
            <Empty>No services or repairs yet.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {work.orders.map((order) => (
                <li key={order.id} className="py-2">
                  <div className="flex items-start justify-between gap-3">
                    <Link href={`/workshop/${order.id}`} className="inline-flex min-h-11 items-center font-semibold text-gold-deep underline">
                      {WORK_TYPE_LABELS[order.type]}, {formatDate(order.date)}
                    </Link>
                    <span className="shrink-0 text-sm text-muted">{WORK_STATUS_LABELS[order.status]}</span>
                  </div>
                  {order.fault ? <div className="text-sm">{order.fault}</div> : null}
                  {order.parts.length > 0 ? (
                    <div className="text-sm text-muted">
                      {order.parts
                        .map((part) => `${part.itemName} × ${formatQuantity(-part.quantityMilli)}`)
                        .join(", ")}
                    </div>
                  ) : null}
                  {work.showCost && order.partsKobo + order.labourKobo > 0 ? (
                    <div className="text-sm text-muted">{formatNaira(order.partsKobo + order.labourKobo)}</div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {current && can(ctx.actor.role, "rate.change") ? (
          <Disclosure label="Change daily balance">
            <ActionForm action={changeRateAction.bind(null, current.assignment.id)}>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field name="dailyBalance" label="New daily balance (₦)" inputMode="decimal" hint={BALANCE_HINT} />
                <Field name="effectiveFrom" label="Starts on" type="date" min={today} defaultValue={today} />
              </div>
              <SubmitButton>Save new balance</SubmitButton>
            </ActionForm>
          </Disclosure>
        ) : null}

        {current && canManage ? (
          <Disclosure label="Return tricycle">
            <ActionForm action={returnTricycleAction.bind(null, current.assignment.id)}>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field name="returnedOn" label="Date returned" type="date" max={today} defaultValue={today} />
                <SelectField name="reason" label="Reason" defaultValue="">
                  <option value="" disabled>Choose…</option>
                  {Object.entries(RETURN_REASON_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </SelectField>
              </div>
              <TextareaField name="note" label="Note (optional)" />
              <SubmitButton>Confirm return</SubmitButton>
            </ActionForm>
          </Disclosure>
        ) : null}

        {tricycle.status === "in_stock" && can(ctx.actor.role, "tricycle.manage") ? (
          <Disclosure label="Retire tricycle">
            <ActionForm action={retireTricycleAction.bind(null, tricycle.id)}>
              <TextareaField name="reason" label="Reason" hint="A retired tricycle cannot be issued again." />
              <SubmitButton>Retire tricycle</SubmitButton>
            </ActionForm>
          </Disclosure>
        ) : null}
      </div>
    </>
  );
}
