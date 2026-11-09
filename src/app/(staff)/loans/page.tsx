import type { Metadata } from "next";
import Link from "next/link";
import { grantLoanAction } from "@/app/actions";
import { ActionForm, Field, SelectField, SubmitButton, TextareaField } from "@/components/form";
import { MoneySourceField } from "@/components/money-source";
import { Card, Disclosure, Empty, PageHeader } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { requirePage } from "@/lib/session";
import { moneySources } from "@/services/cash-book";
import { listLoans, operatorsForLoan } from "@/services/loans";

export const metadata: Metadata = { title: "Loans" };

type Row = Awaited<ReturnType<typeof listLoans>>["active"][number];

function Loans({ rows, owed }: { rows: Row[]; owed: boolean }) {
  return (
    <ul className="divide-y divide-line">
      {rows.map((row) => (
        <li key={row.id}>
          <Link href={`/loans/${row.id}`} className="flex items-start justify-between gap-3 py-2">
            <div className="min-w-0">
              <div className="font-semibold">{row.operatorName}</div>
              <div className="text-sm text-muted">{formatNaira(row.principalKobo)} given {formatDate(row.disbursedOn)}</div>
            </div>
            <div className="shrink-0 text-right font-semibold tabular-nums">
              {owed ? `${formatNaira(row.principalKobo - row.repaidKobo)} left` : "Cleared"}
            </div>
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
        <Card title={`Active (${data.active.length})`}>
          {data.active.length === 0 ? <Empty>No operator has a loan to clear.</Empty> : <Loans rows={data.active} owed />}
        </Card>
        {data.cleared.length > 0 ? (
          <Card title="Cleared">
            <Loans rows={data.cleared} owed={false} />
          </Card>
        ) : null}
      </div>
    </>
  );
}
