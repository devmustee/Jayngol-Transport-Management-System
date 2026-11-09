import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  adjustStockAction,
  receiveStockAction,
  setReorderLevelAction,
} from "@/app/actions";
import { ActionForm, Field, SubmitButton, TextareaField } from "@/components/form";
import { Badge, Card, Details, Disclosure, Empty, PageHeader } from "@/components/ui";
import { isUuid } from "@/lib/fields";
import { formatDate, MOVEMENT_LABELS } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { formatQuantity, formatStock } from "@/lib/quantity";
import { requirePage } from "@/lib/session";
import { getStockItem, isLow } from "@/services/store";

export const metadata: Metadata = { title: "Store item" };

export default async function StoreItemPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePage("stock.view");
  const { id } = await params;
  const detail = isUuid(id) ? await getStockItem(ctx, id) : null;
  if (!detail) notFound();

  const { item, movements } = detail;
  const canMove = can(ctx.actor.role, "stock.move");
  const canAdjust = can(ctx.actor.role, "stock.adjust");

  return (
    <>
      <PageHeader
        title={item.name}
        back={{ href: "/store", label: "Store" }}
        action={isLow(item) ? <Badge tone="bad">Low, reorder</Badge> : undefined}
      />
      <div className="space-y-4">
        <Card>
          <Details
            rows={[
              ["In store", formatStock(item.quantityMilli, item.unit)],
              ["Value", formatNaira(item.valueKobo)],
              ["Alert at or below", item.reorderLevelMilli > 0 ? formatQuantity(item.reorderLevelMilli) : "Off"],
            ]}
          />
        </Card>

        {canMove ? (
          <Card title="Receive stock">
            <ActionForm action={receiveStockAction.bind(null, id)}>
              <Field name="quantity" label={`Quantity (${item.unit}s)`} inputMode="decimal" />
              <Field name="unitCost" label={`Cost per ${item.unit} (₦)`} inputMode="decimal" />
              <Field name="note" label="Supplier or note (optional)" />
              <SubmitButton>Receive</SubmitButton>
            </ActionForm>
          </Card>
        ) : null}

        {canMove ? (
          <Disclosure label="Change reorder alert">
            <ActionForm action={setReorderLevelAction.bind(null, id)}>
              <Field name="reorderLevel" label="Alert when at or below" inputMode="decimal" defaultValue={String(item.reorderLevelMilli / 1000)} hint="0 turns the alert off." />
              <SubmitButton tone="plain">Save</SubmitButton>
            </ActionForm>
          </Disclosure>
        ) : null}

        {canAdjust ? (
          <Disclosure label="Adjust after a count">
            <ActionForm action={adjustStockAction.bind(null, id)}>
              <Field name="counted" label="Quantity counted" inputMode="decimal" />
              <TextareaField name="reason" label="Reason for the difference" />
              <SubmitButton tone="plain">Save count</SubmitButton>
            </ActionForm>
          </Disclosure>
        ) : null}

        <Card title="History">
          {movements.length === 0 ? (
            <Empty>No movements yet.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {movements.map((m) => (
                <li key={m.id} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="font-semibold">{MOVEMENT_LABELS[m.kind]}</div>
                    <div className="text-sm text-muted">
                      {formatDate(m.businessDate)}
                      {m.workOrderId && m.tricycleCode ? (
                        <> · <Link href={`/workshop/${m.workOrderId}`} className="underline">{m.tricycleCode}</Link></>
                      ) : null}
                    </div>
                    {m.reason ? <div className="text-sm">{m.reason}</div> : null}
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-semibold">{m.quantityMilli > 0 ? "+" : "−"}{formatQuantity(Math.abs(m.quantityMilli))}</div>
                    <div className="text-sm text-muted">{formatNaira(Math.abs(m.costKobo))}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
