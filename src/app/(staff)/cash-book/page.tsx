import type { Metadata } from "next";
import Link from "next/link";
import { Card, Empty, PageHeader } from "@/components/ui";
import { businessDate } from "@/lib/clock";
import { isUuid } from "@/lib/fields";
import { BOOK_LABELS, formatDate, formatDateTime, queryValue } from "@/lib/format";
import { readHistoryFilter } from "@/lib/history-filter";
import { formatNaira } from "@/lib/money";
import { requirePage } from "@/lib/session";
import { BOOK_KINDS, cashBook, moneySources, type BookKind, type BookRow } from "@/services/cash-book";

export const metadata: Metadata = { title: "Cash book" };

const INPUT = "mt-1 min-h-11 w-full rounded-lg border border-line bg-card px-3 text-base";

const KIND_LABELS: Record<BookKind, string> = {
  payments: "Payments",
  savings: "Savings",
  expenses: "Expenses",
  loans: "Loans",
  moves: "Money moved",
};

function detail(row: BookRow) {
  if (row.receipt) return `${row.receipt} · ${row.operator}`;
  return row.operator ?? row.purpose ?? "";
}

function href(row: BookRow) {
  if (row.payment_id) return `/payments/${row.payment_id}`;
  if (row.deposit_id) return `/deposits/${row.deposit_id}`;
  if (row.refund_operator_id) return `/operators/${row.refund_operator_id}#deposit`;
  if (row.advance_id) return `/expenses/${row.advance_id}`;
  if (row.loan_id) return `/loans/${row.loan_id}`;
  if (row.transfer_id) return `/transfers#move-${row.transfer_id}`;
  if (row.source_type === "opening_balance") return "/bank";
  return null;
}

const signed = (kobo: number) => `${kobo < 0 ? "-" : ""}${formatNaira(Math.abs(kobo))}`;

type SideData = Awaited<ReturnType<typeof cashBook>>["cash"];

/** Held at the start, what came in and went out, what was moved, and held at the end. */
function Side({ title, subtitle, side, narrowed }: { title: string; subtitle?: string; side: SideData; narrowed: boolean }) {
  const moved = side.movedIn - side.movedOut;
  return (
    <Card title={title} subtitle={subtitle}>
      <dl className="divide-y divide-line text-sm">
        <div className="flex justify-between gap-3 py-2">
          <dt className="text-muted">At the start</dt>
          <dd className="tabular-nums">{signed(side.openingKobo)}</dd>
        </div>
        <div className="flex justify-between gap-3 py-2">
          <dt>Money in</dt>
          <dd className="tabular-nums text-ok">+{formatNaira(side.moneyIn)}</dd>
        </div>
        <div className="flex justify-between gap-3 py-2">
          <dt>Money out</dt>
          <dd className="tabular-nums text-danger">-{formatNaira(side.moneyOut)}</dd>
        </div>
        {side.movedIn + side.movedOut > 0 ? (
          <div className="flex justify-between gap-3 py-2">
            <dt>
              Moved {moved >= 0 ? "here" : "away"}
              <span className="block text-xs text-muted">
                {formatNaira(side.movedIn)} in, {formatNaira(side.movedOut)} out, between people, the bank and the owner
              </span>
            </dt>
            <dd className="tabular-nums">{moved >= 0 ? "+" : ""}{signed(moved)}</dd>
          </div>
        ) : null}
        <div className="flex justify-between gap-3 py-2 font-bold">
          <dt>At the end</dt>
          <dd className="tabular-nums">{signed(side.closingKobo)}</dd>
        </div>
      </dl>
      {narrowed ? <p className="mt-2 text-xs text-muted">The start and end cover everything; the lines between cover the kind chosen.</p> : null}
    </Card>
  );
}

export default async function CashBookPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, unknown>>;
}) {
  const ctx = await requirePage("finance.view");
  const params = await searchParams;
  const filter = readHistoryFilter(params);
  const today = businessDate(ctx.clock());
  const [from, to] = [filter.from ?? `${today.slice(0, 8)}01`, filter.to ?? today].sort() as [string, string];
  const whoseParam = queryValue(params.whose);
  const whose = whoseParam === "bank" || whoseParam === "owner" || (whoseParam && isUuid(whoseParam)) ? whoseParam : null;
  const kindParam = queryValue(params.kind);
  const kind = kindParam && kindParam in BOOK_KINDS ? (kindParam as BookKind) : null;
  const [book, people] = await Promise.all([cashBook(ctx, { from, to, whose, kind }), moneySources(ctx)]);
  const person = whose && isUuid(whose) ? people.find((p) => p.id === whose) : null;
  const showCash = !whose || isUuid(whose);
  const showBank = !whose || whose === "bank";
  const ownerUsed = [book.owner.moneyIn, book.owner.moneyOut, book.owner.movedIn, book.owner.movedOut, book.owner.closingKobo].some((v) => v !== 0);
  const showOwner = whose === "owner" || (!whose && ownerUsed);

  return (
    <>
      <PageHeader title="Cash book" subtitle="Every naira in and out" back={{ href: "/money", label: "Money" }} />
      <form className="mb-4 grid grid-cols-2 items-end gap-3 sm:grid-cols-5">
        <label className="min-w-0 font-medium">
          From
          <input type="date" name="from" defaultValue={from} className={INPUT} />
        </label>
        <label className="min-w-0 font-medium">
          To
          <input type="date" name="to" defaultValue={to} className={INPUT} />
        </label>
        <label className="min-w-0 font-medium">
          Whose money
          <select name="whose" defaultValue={whose ?? ""} className={INPUT}>
            <option value="">Everything</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                Cash held by {p.name}
              </option>
            ))}
            {whose && isUuid(whose) && !person ? <option value={whose}>Cash of someone who has left</option> : null}
            <option value="bank">Bank</option>
            <option value="owner">Owner</option>
          </select>
        </label>
        <label className="min-w-0 font-medium">
          Kind
          <select name="kind" defaultValue={kind ?? ""} className={INPUT}>
            <option value="">All kinds</option>
            {(Object.keys(BOOK_KINDS) as BookKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <button className="col-span-2 min-h-11 rounded-lg bg-ink px-4 font-semibold text-gold-light sm:col-span-1">Show</button>
      </form>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {showCash ? (
            <Side title={person ? `Cash held by ${person.name}` : whose ? "Cash" : "Cash, everyone"} side={book.cash} narrowed={book.narrowed} />
          ) : null}
          {showBank ? <Side title="Bank, transfer and POS" side={book.bank} narrowed={book.narrowed} /> : null}
          {showOwner ? (
            <Side
              title="Owner's own money"
              subtitle="Paid from or into the owner's own pocket. A minus is what the owner has paid for the business."
              side={book.owner}
              narrowed={book.narrowed}
            />
          ) : null}
        </div>
        {book.truncated ? <p className="text-sm text-muted">Showing the latest 400 entries. The totals cover everything. Narrow the dates to see older entries.</p> : null}
        {book.rows.length === 0 ? (
          <Empty>No money moved in these dates.</Empty>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
            {book.rows.map((row) => {
              const link = href(row);
              const happened = businessDate(new Date(row.at));
              const body = (
                <>
                  <div className="min-w-0">
                    <div className="font-semibold">{BOOK_LABELS[row.source_type] ?? row.source_type}</div>
                    <div className="break-words text-sm">{detail(row)}</div>
                    <div className="text-sm text-muted">
                      {formatDateTime(new Date(row.at))} · {row.account === "cash" ? row.custodian : row.account === "owner" ? "Owner" : "Bank"}
                    </div>
                    {row.date !== happened ? (
                      <div className="text-xs font-semibold text-gold-deep">
                        Counts on {formatDate(row.date)}, {row.date > happened ? "after that day's cash count" : "the day it was for"}
                      </div>
                    ) : null}
                  </div>
                  <span className={`shrink-0 font-semibold tabular-nums ${row.amount < 0 ? "text-danger" : "text-ok"}`}>
                    {row.amount < 0 ? "-" : "+"}
                    {formatNaira(Math.abs(row.amount))}
                  </span>
                </>
              );
              return (
                <li key={row.id}>
                  {link ? (
                    <Link href={link} className="flex items-start justify-between gap-3 p-3 hover:bg-gold-wash">
                      {body}
                    </Link>
                  ) : (
                    <div className="flex items-start justify-between gap-3 p-3">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
