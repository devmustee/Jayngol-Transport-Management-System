import type { Metadata } from "next";
import Link from "next/link";
import { Pencil } from "lucide-react";
import { notFound } from "next/navigation";
import {
  changeIssueDateAction,
  changeTricycleBalanceAction,
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
  const { balance } = detail;

  const balanceValue = (kobo: number | null) => (
    <div>
      {kobo == null ? <Badge tone="warning">Not set</Badge> : formatNaira(kobo)}
      {balance.upcoming.map((b) => (
        <div key={b.id} className="text-xs font-medium text-muted">
          {formatNaira(b.amountKobo)} from {formatDate(b.effectiveFrom)}
        </div>
      ))}
    </div>
  );

  const balanceChange =
    can(ctx.actor.role, "rate.change") && tricycle.status !== "retired" ? (
      <details className="group mt-3" open={balance.today == null && balance.upcoming.length === 0}>
        <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-xl border border-line bg-card px-4 text-sm font-bold text-gold-deep transition-colors hover:bg-gold-wash/50 [&::-webkit-details-marker]:hidden">
          <Pencil size={16} aria-hidden />
          <span className="group-open:hidden">{balance.today == null ? "Set daily balance" : "Change daily balance"}</span>
          <span className="hidden group-open:inline">Close</span>
        </summary>
        <div className="mt-3 rounded-xl border border-line/60 bg-card-subtle/50 p-4">
          <ActionForm action={changeTricycleBalanceAction.bind(null, tricycle.id)}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field name="dailyBalance" label="Daily balance (₦)" inputMode="decimal" hint={BALANCE_HINT} />
              <Field
                name="effectiveFrom"
                label="Starts on"
                type="date"
                min={today}
                defaultValue={today}
                hint={current ? "Charges change from this day. It cannot be in the past." : "It cannot be in the past."}
              />
            </div>
            <TextareaField name="reason" label="Reason" />
            <SubmitButton>Save daily balance</SubmitButton>
          </ActionForm>
        </div>
      </details>
    ) : null;

  const issueDateChange =
    current && can(ctx.actor.role, "assignment.manage") ? (
      <details className="group mt-3">
        <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-xl border border-line bg-card px-4 text-sm font-bold text-gold-deep transition-colors hover:bg-gold-wash/50 [&::-webkit-details-marker]:hidden">
          <Pencil size={16} aria-hidden />
          <span className="group-open:hidden">Change date issued</span>
          <span className="hidden group-open:inline">Close</span>
        </summary>
        <div className="mt-3 rounded-xl border border-line/60 bg-card-subtle/50 p-4">
          <ActionForm action={changeIssueDateAction.bind(null, current.assignment.id)}>
            <Field
              name="issuedOn"
              label="Date issued"
              type="date"
              max={today}
              min={tricycle.purchasedOn}
              defaultValue={current.assignment.issuedOn}
              hint="Balances are owed from the day after this date."
            />
            <p className="text-sm text-muted">
              A later date takes back the balances already raised for the days in between, and any money paid on them goes to
              other days. An earlier date does not raise balances for the extra days.
            </p>
            <TextareaField name="reason" label="Reason" />
            <SubmitButton>Save date issued</SubmitButton>
          </ActionForm>
        </div>
      </details>
    ) : null;

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
                ["Daily balance", balanceValue(current.dailyBalanceKobo)],
              ]}
            />
            {balanceChange}
            {issueDateChange}
          </Card>
        ) : null}

        {!current && tricycle.status !== "retired" ? (
          <Card title="Daily balance">
            <Details rows={[["Daily balance", balanceValue(balance.today)]]} />
            {balanceChange}
          </Card>
        ) : null}

        {canIssue ? (
          <Card title="Issue to an operator">
            {balance.today == null ? (
              <p className="text-muted">Set this tricycle&apos;s daily balance before issuing it.</p>
            ) : available.length === 0 ? (
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
                </div>
                <p className="text-sm text-muted">
                  The operator will pay this tricycle&apos;s daily balance of {formatNaira(balance.today)}.
                </p>
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

        <Card
          title="Service and repairs"
          action={
            <Link href={`/tricycles/${id}/workshop`} className="inline-flex min-h-11 items-center text-sm font-semibold text-gold-deep underline">
              Workshop report
            </Link>
          }
        >
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

        {balance.history.length > 0 ? (
          <Disclosure label="Daily balance history">
            <ul className="divide-y divide-line">
              {balance.history.map((b) => (
                <li key={b.id} className="py-2">
                  <div className="font-semibold">
                    {formatNaira(b.amountKobo)} from {formatDate(b.effectiveFrom)}
                  </div>
                  {b.reason ? <div className="text-sm text-muted">{b.reason}</div> : null}
                </li>
              ))}
            </ul>
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
