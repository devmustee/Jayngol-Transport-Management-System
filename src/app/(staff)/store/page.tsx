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
  const canMove = can(ctx.actor.role, "stock.move");
  return (
    <>
      <PageHeader
        title="Store"
        subtitle={`Stock value ${formatNaira(value)}`}
        action={
          <div className="flex flex-wrap gap-2">
            {canMove ? <LinkButton href="/store/take">Take out items</LinkButton> : null}
            <LinkButton href="/store/usage" variant={canMove ? "secondary" : "primary"}>
              Usage record
            </LinkButton>
          </div>
        }
      />
      <div className="space-y-4">
        {items.length === 0 ? (
          <Empty>No items yet.</Empty>
        ) : (
          <ul className="space-y-3">
            {items.map((item) => (
              <li key={item.id}>
                <Card className="relative">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link href={`/store/${item.id}`} className="font-bold after:absolute after:inset-0 after:rounded-[inherit]">
                        {item.name}
                      </Link>
                      <div className="text-sm text-muted">
                        {formatNaira(item.valueKobo)}
                        {item.quantityMilli > 0
                          ? ` · ${formatNaira(Math.round((item.valueKobo * 1000) / item.quantityMilli))} a ${item.unit}`
                          : ""}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-bold">{formatStock(item.quantityMilli, item.unit)}</div>
                      {isLow(item) ? <Badge tone="bad">Low, reorder</Badge> : null}
                    </div>
                  </div>
                  {canMove && item.quantityMilli > 0 ? (
                    <div className="relative z-10 mt-3 flex justify-end">
                      <Link
                        href={`/store/take?item=${item.id}`}
                        className="inline-flex min-h-11 items-center rounded-xl border border-line bg-card px-4 text-sm font-semibold text-ink hover:border-line-strong hover:bg-card-subtle"
                      >
                        Take out
                      </Link>
                    </div>
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>
        )}
        {canMove ? (
          <Disclosure label="Add an item">
            <ActionForm action={createStockItemAction}>
              <Field name="name" label="Name" />
              <Field name="unit" label="Unit" hint="Such as tyre, litre or piece." />
              <SelectField name="kind" label="How it is counted" defaultValue="whole">
                <option value="whole">Whole units</option>
                <option value="part">Part units allowed, such as 1.5 litres</option>
              </SelectField>
              <Field name="reorderLevel" label="Alert when at or below" inputMode="decimal" defaultValue="0" />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  name="quantity"
                  label="Quantity in the store now"
                  inputMode="decimal"
                  placeholder="0"
                  hint="Leave empty if there is none yet."
                />
                <Field name="unitCost" label="Cost per unit (₦)" inputMode="decimal" hint="For the record only. It does not change any balance or the cash book." />
              </div>
              <SubmitButton>Add item</SubmitButton>
            </ActionForm>
          </Disclosure>
        ) : null}
      </div>
    </>
  );
}
