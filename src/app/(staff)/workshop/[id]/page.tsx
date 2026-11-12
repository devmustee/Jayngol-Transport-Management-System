import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  cancelWorkOrderAction,
  checkInServiceAction,
  rescheduleServiceAction,
  returnPartAction,
} from "@/app/actions";
import { ActionForm, Field, SubmitButton, TextareaField } from "@/components/form";
import { CompleteForm } from "@/components/forms/complete-form";
import { TakeOutForm } from "@/components/forms/take-out-form";
import { Badge, Card, Details, Disclosure, Empty, PageHeader } from "@/components/ui";
import { businessDate } from "@/lib/clock";
import { isUuid } from "@/lib/fields";
import { formatDate, formatDateTime, WORK_STATUS_LABELS, WORK_TYPE_LABELS } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { formatStock } from "@/lib/quantity";
import { requirePage } from "@/lib/session";
import { partsToIssue } from "@/services/store";
import { getWorkOrder } from "@/services/workshop";

export const metadata: Metadata = { title: "Work order" };

const TONE = { scheduled: "gold", checked_in: "gold", completed: "good", missed: "bad", cancelled: "plain" } as const;

export default async function WorkOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ taken?: string }>;
}) {
  const ctx = await requirePage("workorder.view");
  const { id } = await params;
  const { taken } = await searchParams;
  const detail = isUuid(id) ? await getWorkOrder(ctx, id) : null;
  if (!detail) notFound();

  const { order, code, parts, partsCostKobo, showCost } = detail;
  const role = ctx.actor.role;
  const inWorkshop = order.status === "checked_in";
  const waiting = order.type === "service" && (order.status === "scheduled" || order.status === "missed");
  const canManage = can(role, "workorder.manage");
  const canMove = can(role, "stock.move") && inWorkshop;
  const stock = canMove ? await partsToIssue(ctx) : null;
  const open = canManage && (inWorkshop || waiting);

  return (
    <>
      <PageHeader
        title={`${code} ${WORK_TYPE_LABELS[order.type].toLowerCase()}`}
        back={{ href: "/workshop", label: "Workshop" }}
        action={<Badge tone={TONE[order.status]}>{WORK_STATUS_LABELS[order.status]}</Badge>}
      />
      <div className="space-y-4">
        {taken ? (
          <p role="status" className="rounded-xl border border-ok-border bg-ok-wash px-4 py-3 text-sm font-medium text-ok">
            Taken out of the store. The items are listed under Parts used.
          </p>
        ) : null}
        <Card>
          <Details
            rows={[
              ["Tricycle", <Link key="t" href={`/tricycles/${order.tricycleId}`} className="text-gold-deep underline">{code}</Link>],
              ...(order.scheduledFor ? ([["Service date", formatDate(order.scheduledFor)]] as [string, string][]) : []),
              ...(order.fault ? ([["Fault", order.fault]] as [string, string][]) : []),
              ...(order.checkedInAt ? ([["Checked in", formatDateTime(order.checkedInAt)]] as [string, string][]) : []),
              ...(order.findings ? ([["Findings", order.findings]] as [string, string][]) : []),
              ...(order.completedAt ? ([["Completed", formatDateTime(order.completedAt)]] as [string, string][]) : []),
              ...(order.cancelReason ? ([["Cancelled because", order.cancelReason]] as [string, string][]) : []),
              ...(showCost && order.status === "completed"
                ? ([["Labour", formatNaira(order.labourCostKobo)], ["Parts", formatNaira(partsCostKobo)]] as [string, string][])
                : []),
            ]}
          />
        </Card>

        {waiting && can(role, "workorder.checkin") ? (
          <ActionForm action={checkInServiceAction.bind(null, id)}>
            <SubmitButton>Check in now</SubmitButton>
          </ActionForm>
        ) : null}

        {order.status === "checked_in" || parts.length > 0 ? (
          <Card title="Parts used" subtitle={inWorkshop && parts.length === 0 ? "Nothing taken from the store yet." : undefined}>
            {parts.length === 0 ? (
              inWorkshop ? null : <Empty>No parts issued.</Empty>
            ) : (
              <ul className="divide-y divide-line">
                {parts.map((part) => (
                  <li key={part.movementId} className="flex flex-wrap items-center justify-between gap-3 py-2">
                    <div>
                      <div className="font-semibold">{part.itemName}</div>
                      <div className="text-sm text-muted">
                        {formatStock(-part.quantityMilli, part.unit)}
                        {showCost ? ` · ${formatNaira(-part.costKobo)}` : ""}
                      </div>
                    </div>
                    {canMove ? (
                      <ActionForm action={returnPartAction.bind(null, part.movementId)}>
                        <SubmitButton tone="plain">Return</SubmitButton>
                      </ActionForm>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {stock ? (
              <div className="mt-4 border-t border-line pt-4">
                <h3 className="mb-3 text-sm font-semibold text-ink">Take from store</h3>
                {stock.length > 0 ? (
                  <TakeOutForm
                    // A fresh, empty form once items have gone out.
                    key={parts.map((part) => part.movementId).join()}
                    fixed
                    jobs={[{ id, code, detail: "" }]}
                    jobId={id}
                    items={stock.map((i) => ({
                      id: i.id,
                      name: i.name,
                      unit: i.unit,
                      wholeOnly: i.wholeOnly,
                      quantityMilli: i.quantityMilli,
                      valueKobo: i.valueKobo,
                    }))}
                    showCost={showCost}
                  />
                ) : (
                  <Empty>The store is empty. Receive stock on an item first.</Empty>
                )}
              </div>
            ) : null}
          </Card>
        ) : null}

        {inWorkshop && canManage ? (
          <Card title="Complete">
            <div className="mb-4 rounded-xl bg-card-subtle px-4 py-3 text-sm">
              <div className="font-medium text-muted">Taken from the store for this job</div>
              {parts.length === 0 ? (
                <div className="mt-1 text-ink">Nothing yet</div>
              ) : (
                <ul className="mt-1 space-y-0.5">
                  {parts.map((part) => (
                    <li key={part.movementId} className="flex justify-between gap-3 text-ink">
                      <span>
                        {part.itemName} · {formatStock(-part.quantityMilli, part.unit)}
                      </span>
                      {showCost ? <span className="tabular-nums">{formatNaira(-part.costKobo)}</span> : null}
                    </li>
                  ))}
                  {showCost ? (
                    <li className="flex justify-between gap-3 border-t border-line pt-1 font-semibold text-ink">
                      <span>Parts total</span>
                      <span className="tabular-nums">{formatNaira(partsCostKobo)}</span>
                    </li>
                  ) : null}
                </ul>
              )}
            </div>
            <CompleteForm id={id} type={order.type} partsCount={parts.length} />
          </Card>
        ) : null}

        {waiting && canManage ? (
          <Disclosure label="Move this service">
            <ActionForm action={rescheduleServiceAction.bind(null, id)}>
              <Field name="scheduledFor" label="New date" type="date" min={businessDate(ctx.clock())} hint="Later services stay on their usual dates." />
              <TextareaField name="reason" label="Reason" />
              <SubmitButton tone="plain">Move service</SubmitButton>
            </ActionForm>
          </Disclosure>
        ) : null}

        {open ? (
          <Disclosure label="Cancel this work order">
            <ActionForm action={cancelWorkOrderAction.bind(null, id)}>
              <TextareaField name="reason" label="Reason" />
              <SubmitButton tone="plain">Cancel work order</SubmitButton>
            </ActionForm>
          </Disclosure>
        ) : null}
      </div>
    </>
  );
}
