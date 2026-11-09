import type { Metadata } from "next";
import Link from "next/link";
import { createStockItemAction } from "@/app/actions";
import { ActionForm, Field, SelectField, SubmitButton } from "@/components/form";
import { Badge, Card, Disclosure, Empty, LinkButton, PageHeader } from "@/components/ui";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { formatStock } from "@/lib/quantity";
import { requirePage } from "@/lib/session";
import { isLow, listStock } from "@/services/store";

export const metadata: Metadata = { title: "Store" };

export default async function StorePage() {
  const ctx = await requirePage("stock.view");
  const items = await listStock(ctx);
  const value = items.reduce((sum, item) => sum + item.valueKobo, 0);
  return (
    <>
      <PageHeader
        title="Store"
        subtitle={`Stock value ${formatNaira(value)}`}
        action={<LinkButton href="/store/usage">Usage record</LinkButton>}
      />
      <div className="space-y-4">
        {items.length === 0 ? (
          <Empty>No items yet.</Empty>
        ) : (
          <ul className="space-y-3">
            {items.map((item) => (
              <li key={item.id}>
                <Link href={`/store/${item.id}`} className="block">
                  <Card>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-bold">{item.name}</div>
                        <div className="text-sm text-muted">{formatNaira(item.valueKobo)}</div>
                      </div>
                      <div className="text-right">
                        <div className="font-bold">{formatStock(item.quantityMilli, item.unit)}</div>
                        {isLow(item) ? <Badge tone="bad">Low, reorder</Badge> : null}
                      </div>
                    </div>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {can(ctx.actor.role, "stock.move") ? (
          <Disclosure label="Add an item">
            <ActionForm action={createStockItemAction}>
              <Field name="name" label="Name" />
              <Field name="unit" label="Unit" hint="Such as tyre, litre or piece." />
              <SelectField name="kind" label="How it is counted" defaultValue="whole">
                <option value="whole">Whole units</option>
                <option value="part">Part units allowed, such as 1.5 litres</option>
              </SelectField>
              <Field name="reorderLevel" label="Alert when at or below" inputMode="decimal" defaultValue="0" />
              <SubmitButton>Add item</SubmitButton>
            </ActionForm>
          </Disclosure>
        ) : null}
      </div>
    </>
  );
}
