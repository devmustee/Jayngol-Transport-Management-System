import type { Metadata } from "next";
import Link from "next/link";
import { Card, Details, Empty, PageHeader } from "@/components/ui";
import { businessDate } from "@/lib/clock";
import { BOOK_LABELS, formatDateTime } from "@/lib/format";
import { readHistoryFilter } from "@/lib/history-filter";
import { formatNaira } from "@/lib/money";
import { requirePage } from "@/lib/session";
import { cashBook, type BookRow } from "@/services/cash-book";

export const metadata: Metadata = { title: "Cash book" };

const INPUT = "mt-1 min-h-11 w-full rounded-lg border border-line bg-card px-3 text-base";

function detail(row: BookRow) {
  if (row.receipt) return `${row.receipt} · ${row.operator}`;
  return row.operator ?? row.purpose ?? "";
}

function href(row: BookRow) {
  if (row.payment_id) return `/payments/${row.payment_id}`;
  if (row.advance_id) return `/expenses/${row.advance_id}`;
  if (row.loan_id) return `/loans/${row.loan_id}`;
  return "#";
}

function Side({ title, side }: { title: string; side: { moneyIn: number; moneyOut: number; net: number } }) {
  return (
    <Card title={title}>
      <Details
        rows={[
          ["Money in", formatNaira(side.moneyIn)],
          ["Money out", formatNaira(side.moneyOut)],
          ["Net", `${side.net < 0 ? "-" : ""}${formatNaira(Math.abs(side.net))}`],
        ]}
      />
    </Card>
  );
}

export default async function CashBookPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, unknown>>;
}) {
  const ctx = await requirePage("finance.view");
  const filter = readHistoryFilter(await searchParams);
  const today = businessDate(ctx.clock());
  const [from, to] = [filter.from ?? `${today.slice(0, 8)}01`, filter.to ?? today].sort() as [string, string];
  const book = await cashBook(ctx, { from, to });

  return (
    <>
      <PageHeader title="Cash book" subtitle="Every naira in and out" back={{ href: "/money", label: "Money" }} />
      <form className="mb-4 grid grid-cols-2 items-end gap-3 sm:grid-cols-3">
        <label className="min-w-0 font-medium">
          From
          <input type="date" name="from" defaultValue={from} className={INPUT} />
        </label>
        <label className="min-w-0 font-medium">
          To
          <input type="date" name="to" defaultValue={to} className={INPUT} />
        </label>
        <button className="col-span-2 min-h-11 rounded-lg bg-ink px-4 font-semibold text-gold-light sm:col-span-1">Show</button>
      </form>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Side title="Cash" side={book.cash} />
          <Side title="Bank, transfer and POS" side={book.bank} />
        </div>
        {book.truncated ? <p className="text-sm text-muted">Showing the latest 400 entries. The totals cover everything. Narrow the dates to see older entries.</p> : null}
        {book.rows.length === 0 ? (
          <Empty>No money moved in these dates.</Empty>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
            {book.rows.map((row) => (
              <li key={row.id}>
                <Link href={href(row)} className="flex items-start justify-between gap-3 p-3 hover:bg-gold-wash">
                  <div className="min-w-0">
                    <div className="font-semibold">{BOOK_LABELS[row.source_type] ?? row.source_type}</div>
                    <div className="break-words text-sm">{detail(row)}</div>
                    <div className="text-sm text-muted">
                      {formatDateTime(new Date(row.at))} · {row.account === "cash" ? row.custodian : "Bank"}
                    </div>
                  </div>
                  <span className={`shrink-0 font-semibold tabular-nums ${row.amount < 0 ? "text-danger" : "text-ok"}`}>
                    {row.amount < 0 ? "-" : "+"}{formatNaira(Math.abs(row.amount))}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
