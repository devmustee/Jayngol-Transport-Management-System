import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  cancelWorkOrderAction,
  checkInServiceAction,
  completeWorkOrderAction,
  issuePartAction,
  rescheduleServiceAction,
  returnPartAction,
} from "@/app/actions";
import { ActionForm, Field, SelectField, SubmitButton, TextareaField } from "@/components/form";
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

export default async function WorkOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePage("workorder.view");
  const { id } = await params;
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
          <Card title="Parts used">
            {parts.length === 0 ? (
              <Empty>No parts issued.</Empty>
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
              <div className="mt-4 space-y-3">
                {stock.length > 0 ? (
                  <Disclosure label="Issue a part">
                    <ActionForm action={issuePartAction.bind(null, id)}>
                      <SelectField name="itemId" label="Part" defaultValue="">
                        <option value="" disabled>Choose…</option>
                        {stock.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name} ({formatStock(item.quantityMilli, item.unit)} left)
                          </option>
                        ))}
                      </SelectField>
                      <Field name="quantity" label="Quantity" inputMode="decimal" />
                      <SubmitButton>Issue from store</SubmitButton>
                    </ActionForm>
                  </Disclosure>
                ) : null}
              </div>
            ) : null}
          </Card>
        ) : null}

        {inWorkshop && canManage ? (
          <Card title="Complete">
            <ActionForm action={completeWorkOrderAction.bind(null, id)}>
              <TextareaField name="findings" label="What was found and done" />
              <Field name="labourCost" label="Labour cost (₦)" inputMode="decimal" hint="Paid by the company. Never charged to the operator." />
              <SubmitButton>{order.type === "maintenance" ? "Complete and return to road" : "Complete service"}</SubmitButton>
            </ActionForm>
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
