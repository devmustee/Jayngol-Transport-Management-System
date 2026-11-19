import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight, HandCoins } from "lucide-react";
import { grantLoanAction } from "@/app/actions";
import { ActionForm, SubmitButton, TextareaField } from "@/components/form";
import { LoanOperatorPicker } from "@/components/forms/loan-operator-picker";
import { MoneySourceField } from "@/components/money-source";
import { Badge, Card, Disclosure, Empty, PageHeader, SearchBar } from "@/components/ui";
import { formatDate, queryValue } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { formatPhone } from "@/lib/phone";
import { requirePage } from "@/lib/session";
import { moneySources } from "@/services/cash-book";
import { listLoans, operatorsForLoan } from "@/services/loans";

export const metadata: Metadata = { title: "Loans" };

type Active = Awaited<ReturnType<typeof listLoans>>["active"][number];
type Cleared = Awaited<ReturnType<typeof listLoans>>["cleared"][number];

const squash = (text: string | null | undefined) => (text ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const digits = (text: string | null | undefined) => (text ?? "").replace(/\D/g, "");

/** Operator name or phone, or the tricycle they hold now, ignoring spaces, commas and case. */
function matches(row: Cleared, query: string) {
  const text = squash(query);
  if (!text) return true;
  if ([row.operatorName, row.tricycleCode, row.registration, row.note].some((f) => squash(f).includes(text))) return true;
  const number = digits(query);
  if (number.length < 3) return false;
  const phone = digits(row.operatorPhone);
  return (phone.startsWith("234") ? `0${phone.slice(3)}` : phone).includes(number) || phone.includes(number);
}

function Who({ row }: { row: Cleared }) {
  return (
    <div className="text-sm text-muted">
      {formatPhone(row.operatorPhone)}
      {" · "}
      {row.tricycleCode ? `${row.tricycleCode} (${row.registration})` : "No tricycle now"}
    </div>
  );
}

const quiet = (days: number) => (days === 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`);

/** Loans still owed, the one quiet for longest first. */
function ActiveLoans({ rows, canCollect }: { rows: Active[]; canCollect: boolean }) {
  return (
    <ul className="divide-y divide-line">
      {rows.map((row) => (
        <li key={row.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-4">
          <Link href={`/loans/${row.id}`} className="group flex min-h-12 min-w-0 flex-1 items-center justify-between gap-3 hover:text-gold-deep">
            <div className="min-w-0">
              <div className="font-bold leading-snug">{row.operatorName}</div>
              <Who row={row} />
              <div className="text-sm text-muted">
                {formatNaira(row.principalKobo)} given {formatDate(row.disbursedOn)}
              </div>
              <div className="mt-1">
                <Badge tone={row.quietDays >= 14 ? "bad" : row.quietDays >= 7 ? "warning" : "plain"}>
                  {row.lastRepaidOn ? `Last repaid ${quiet(row.quietDays)}` : `Nothing repaid · ${quiet(row.quietDays)}`}
                </Badge>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <div className="text-right">
                <div className="font-bold tabular-nums text-ink">{formatNaira(row.owedKobo)}</div>
                <div className="text-xs text-muted">left</div>
              </div>
              <ChevronRight size={18} aria-hidden className="text-muted/60 group-hover:text-gold-deep" />
            </div>
          </Link>
          {canCollect ? (
            <Link
              href={`/payments/new?operator=${row.operatorId}&for=loan`}
              aria-label={`Take loan repayment from ${row.operatorName}`}
              className="inline-flex min-h-11 items-center justify-center gap-2 self-end rounded-xl bg-gold px-4 text-sm font-bold text-ink shadow-gold-sm transition-all hover:brightness-105 active:scale-[0.98] sm:self-center"
            >
              <HandCoins size={16} aria-hidden />
              Take repayment
            </Link>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function ClearedLoans({ rows }: { rows: Cleared[] }) {
  return (
    <ul className="divide-y divide-line">
      {rows.map((row) => (
        <li key={row.id}>
          <Link href={`/loans/${row.id}`} className="flex min-h-12 items-center justify-between gap-3 py-2 hover:text-gold-deep">
            <div className="min-w-0">
              <div className="font-semibold">{row.operatorName}</div>
              <Who row={row} />
              <div className="text-sm text-muted">{formatNaira(row.principalKobo)} given {formatDate(row.disbursedOn)}</div>
            </div>
            <Badge tone="good">Cleared</Badge>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default async function LoansPage({ searchParams }: { searchParams: Promise<{ give?: string; q?: string }> }) {
  const ctx = await requirePage("finance.view");
  const params = await searchParams;
  const give = params.give === "1";
  const q = queryValue(params.q)?.trim().slice(0, 60) ?? "";
  const data = await listLoans(ctx);
  const active = data.active.filter((row) => matches(row, q));
  const cleared = data.cleared.filter((row) => matches(row, q));
  const hasLoans = data.active.length + data.cleared.length > 0;
  const [sources, pick] = data.canApprove
    ? await Promise.all([moneySources(ctx), operatorsForLoan(ctx)])
    : [[], { choices: [], owingCount: 0 }];
  return (
    <>
      <PageHeader title="Loans" subtitle={`Owed to the company: ${formatNaira(data.outstandingKobo)}`} back={{ href: "/money", label: "Money" }} />
      <div className="space-y-4">
        {data.canApprove ? (
          <Disclosure label="Give a loan" open={give}>
            <ActionForm action={grantLoanAction}>
              <LoanOperatorPicker choices={pick.choices} owingCount={pick.owingCount}>
                <MoneySourceField sources={sources} />
                <TextareaField name="note" label="Note (optional)" />
              </LoanOperatorPicker>
              <SubmitButton>Give loan</SubmitButton>
            </ActionForm>
          </Disclosure>
        ) : null}
        {hasLoans ? (
          <div>
            <SearchBar q={q} placeholder="Search operator, phone, tricycle or plate" />
            {q ? (
              <p className="-mt-2 text-sm text-muted" aria-live="polite">
                {active.length + cleared.length === 0
                  ? `No loan matches "${q}".`
                  : `${active.length} to collect, owing ${formatNaira(active.reduce((sum, row) => sum + row.owedKobo, 0))}, and ${cleared.length} cleared match "${q}".`}{" "}
                <Link href="/loans" className="inline-flex min-h-11 items-center font-semibold text-gold-deep underline underline-offset-2">
                  Clear search
                </Link>
              </p>
            ) : null}
          </div>
        ) : null}
        {data.active.length > 0 && !q ? (
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-2xl border border-line bg-card p-4 shadow-premium">
              <div className="text-xs font-medium text-muted">To collect</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-ink">{formatNaira(data.outstandingKobo)}</div>
            </div>
            <div className="rounded-2xl border border-line bg-card p-4 shadow-premium">
              <div className="text-xs font-medium text-muted">Operators</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-ink">{data.active.length}</div>
            </div>
          </div>
        ) : null}
        <Card title={`Loans to collect (${active.length})`} subtitle="The loan with no repayment for longest is first">
          {active.length === 0 ? (
            <Empty>{q ? "No loan to collect matches." : "No operator has a loan to clear."}</Empty>
          ) : (
            <ActiveLoans rows={active} canCollect={data.canCollect} />
          )}
        </Card>
        {cleared.length > 0 ? (
          <Card title={`Cleared (${cleared.length})`}>
            <ClearedLoans rows={cleared} />
          </Card>
        ) : null}
      </div>
    </>
  );
}
