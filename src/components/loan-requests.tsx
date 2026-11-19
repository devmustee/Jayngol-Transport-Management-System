import Link from "next/link";
import {
  approveLoanRequestAction,
  rejectLoanRequestAction,
  withdrawLoanRequestAction,
} from "@/app/actions";
import { ActionForm, Field, SubmitButton, TextareaField } from "@/components/form";
import { MoneySourceField } from "@/components/money-source";
import { Badge, Card, Disclosure } from "@/components/ui";
import { daysBetween, businessDate } from "@/lib/clock";
import { formatDate } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import type { listLoanRequests } from "@/services/loan-requests";

type Data = Awaited<ReturnType<typeof listLoanRequests>>;
type Waiting = Data["waiting"][number];
type Answered = Data["answered"][number];

const STATUS = {
  approved: { tone: "good", label: "Approved" },
  rejected: { tone: "bad", label: "Rejected" },
  withdrawn: { tone: "plain", label: "Withdrawn" },
  waiting: { tone: "warning", label: "Waiting" },
} as const;

const waited = (from: Date, now: Date) => {
  const days = daysBetween(businessDate(from), businessDate(now));
  return days === 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
};

function Who({ row }: { row: Waiting | Answered }) {
  return (
    <div className="text-sm text-muted">
      {row.tricycleCode ? `${row.tricycleCode} (${row.registration ?? "no plate"})` : "No tricycle now"}
    </div>
  );
}

/** One waiting request: who, how much, why, the risk, then Approve and Reject for the Manager. */
function WaitingRequest({
  row,
  now,
  canApprove,
  mine,
  sources,
}: {
  row: Waiting;
  now: Date;
  canApprove: boolean;
  mine: boolean;
  sources: { id: string; name: string; availableKobo: number }[];
}) {
  return (
    <li id={`request-${row.id}`} className="scroll-mt-24 space-y-3 py-4 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/operators/${row.operatorId}`} className="font-bold leading-snug hover:text-gold-deep [overflow-wrap:anywhere]">
            {row.operatorName}
          </Link>
          <Who row={row} />
        </div>
        <div className="shrink-0 text-right">
          <div className="text-lg font-bold tabular-nums">{formatNaira(row.amountKobo)}</div>
          <Badge tone="warning">Waiting</Badge>
        </div>
      </div>
      <p className="text-sm">{row.reason}</p>
      <p className="text-sm text-muted">
        Asked by {row.requestedByName} {waited(row.requestedAt, now)}
        {" · "}
        <span className={row.owedNowKobo > 0 ? "font-semibold text-danger" : ""}>
          {row.owedNowKobo > 0 ? `Owes ${formatNaira(row.owedNowKobo)} in balances and fines` : "Owes nothing today"}
        </span>
      </p>
      {canApprove ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Disclosure label="Approve">
            <ActionForm action={approveLoanRequestAction.bind(null, row.id)}>
              <Field
                name="amount"
                label="Amount (₦)"
                inputMode="decimal"
                autoComplete="off"
                placeholder={(row.amountKobo / 100).toLocaleString("en-NG")}
                hint={`Leave empty to give the ${formatNaira(row.amountKobo)} asked for. You can lower it, not raise it.`}
              />
              <MoneySourceField sources={sources} />
              <SubmitButton>Approve and give loan</SubmitButton>
            </ActionForm>
          </Disclosure>
          <Disclosure label="Reject">
            <ActionForm action={rejectLoanRequestAction.bind(null, row.id)}>
              <TextareaField name="rejectReason" label="Why" rows={2} hint={`${row.requestedByName} is told this reason.`} />
              <SubmitButton tone="plain">Reject request</SubmitButton>
            </ActionForm>
          </Disclosure>
        </div>
      ) : mine ? (
        <ActionForm action={withdrawLoanRequestAction.bind(null, row.id)}>
          <SubmitButton tone="plain">Withdraw request</SubmitButton>
        </ActionForm>
      ) : null}
    </li>
  );
}

export function LoanRequestLists({
  data,
  now,
  userId,
  sources,
}: {
  data: Data;
  now: Date;
  userId: string;
  sources: { id: string; name: string; availableKobo: number }[];
}) {
  const waiting = data.canApprove ? data.waiting : data.waiting.filter((row) => row.requestedBy === userId);
  const others = data.waiting.length - waiting.length;
  if (waiting.length === 0 && data.answered.length === 0 && others === 0) return null;
  return (
    <>
      {waiting.length > 0 || others > 0 ? (
        <Card
          title={data.canApprove ? `Loan requests (${waiting.length})` : `My requests waiting (${waiting.length})`}
          subtitle={data.canApprove ? "Oldest first. No money moves until you approve." : "The Manager decides. No money moves until then."}
        >
          {waiting.length > 0 ? (
            <ul className="divide-y divide-line">
              {waiting.map((row) => (
                <WaitingRequest
                  key={row.id}
                  row={row}
                  now={now}
                  canApprove={data.canApprove}
                  mine={row.requestedBy === userId}
                  sources={sources}
                />
              ))}
            </ul>
          ) : null}
          {others > 0 ? (
            <p className="mt-3 text-sm text-muted">
              {others} more request{others === 1 ? "" : "s"} from others waiting for the Manager.
            </p>
          ) : null}
        </Card>
      ) : null}
      {data.answered.length > 0 ? (
        <Card title={data.canApprove ? "Answered requests" : "My answered requests"}>
          <ul className="divide-y divide-line">
            {data.answered.map((row) => {
              const status = STATUS[row.status];
              const body = (
                <>
                  <div className="min-w-0">
                    <div className="font-semibold [overflow-wrap:anywhere]">{row.operatorName}</div>
                    <div className="text-sm text-muted">
                      {formatNaira(row.amountKobo)} asked by {row.requestedByName}
                      {row.decidedAt ? ` · ${formatDate(businessDate(row.decidedAt))}` : ""}
                      {row.status === "approved" && row.givenKobo !== null && row.givenKobo !== row.amountKobo
                        ? ` · ${formatNaira(row.givenKobo)} given`
                        : ""}
                    </div>
                    {row.rejectReason ? <div className="text-sm">Why: {row.rejectReason}</div> : null}
                  </div>
                  <Badge tone={status.tone}>{status.label}</Badge>
                </>
              );
              return (
                <li key={row.id} id={`request-${row.id}`} className="scroll-mt-24">
                  {row.loanId ? (
                    <Link href={`/loans/${row.loanId}`} className="flex min-h-12 items-center justify-between gap-3 py-2 hover:text-gold-deep">
                      {body}
                    </Link>
                  ) : (
                    <div className="flex min-h-12 items-center justify-between gap-3 py-2">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}
    </>
  );
}
