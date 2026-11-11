import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight, HandCoins } from "lucide-react";
import { grantLoanAction } from "@/app/actions";
import { ActionForm, Field, SelectField, SubmitButton, TextareaField } from "@/components/form";
import { MoneySourceField } from "@/components/money-source";
import { Badge, Card, Disclosure, Empty, PageHeader } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { requirePage } from "@/lib/session";
import { moneySources } from "@/services/cash-book";
import { listLoans, operatorsForLoan } from "@/services/loans";

export const metadata: Metadata = { title: "Loans" };

type Active = Awaited<ReturnType<typeof listLoans>>["active"][number];
type Cleared = Awaited<ReturnType<typeof listLoans>>["cleared"][number];

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
              className="inline-flex min-h-11 items-center justify-center gap-2 self-end rounded-xl bg-gradient-to-r from-gold to-gold-light px-4 text-sm font-bold text-ink shadow-gold-sm transition-all hover:brightness-105 active:scale-[0.98] sm:self-center"
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
              <div className="text-sm text-muted">{formatNaira(row.principalKobo)} given {formatDate(row.disbursedOn)}</div>
            </div>
            <Badge tone="good">Cleared</Badge>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default async function LoansPage() {
  const ctx = await requirePage("finance.view");
  const data = await listLoans(ctx);
  const [sources, operators] = data.canApprove
    ? await Promise.all([moneySources(ctx), operatorsForLoan(ctx)])
    : [[], []];
  return (
    <>
      <PageHeader title="Loans" subtitle={`Owed to the company: ${formatNaira(data.outstandingKobo)}`} back={{ href: "/money", label: "Money" }} />
      <div className="space-y-4">
        {data.canApprove ? (
          <Disclosure label="Give a loan">
            <ActionForm action={grantLoanAction}>
              <SelectField name="operatorId" label="Operator" defaultValue="" hint="Operators with a loan to clear are not listed.">
                <option value="" disabled>Choose…</option>
                {operators.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </SelectField>
              <Field name="amount" label="Amount (₦)" inputMode="decimal" autoComplete="off" hint="No interest or fee is added." />
              <MoneySourceField sources={sources} />
              <TextareaField name="note" label="Note (optional)" />
              <SubmitButton>Give loan</SubmitButton>
            </ActionForm>
          </Disclosure>
        ) : null}
        {data.active.length > 0 ? (
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-2xl border border-line bg-card p-4 shadow-premium">
              <div className="text-xs font-bold uppercase tracking-wider text-muted">To collect</div>
              <div className="mt-1 text-2xl font-black tabular-nums text-ink">{formatNaira(data.outstandingKobo)}</div>
            </div>
            <div className="rounded-2xl border border-line bg-card p-4 shadow-premium">
              <div className="text-xs font-bold uppercase tracking-wider text-muted">Operators</div>
              <div className="mt-1 text-2xl font-black tabular-nums text-ink">{data.active.length}</div>
            </div>
          </div>
        ) : null}
        <Card title={`Loans to collect (${data.active.length})`} subtitle="The loan with no repayment for longest is first">
          {data.active.length === 0 ? (
            <Empty>No operator has a loan to clear.</Empty>
          ) : (
            <ActiveLoans rows={data.active} canCollect={data.canCollect} />
          )}
        </Card>
        {data.cleared.length > 0 ? (
          <Card title="Cleared">
            <ClearedLoans rows={data.cleared} />
          </Card>
        ) : null}
      </div>
    </>
  );
}
