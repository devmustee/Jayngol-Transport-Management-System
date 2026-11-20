import type { Metadata } from "next";
import { acceptTransferAction, rejectTransferAction, voidTransferAction } from "@/app/actions";
import { ActionForm, SubmitButton, TextareaField } from "@/components/form";
import { TransferForm } from "@/components/forms/transfer-form";
import { Badge, Card, Disclosure, Empty, PageHeader } from "@/components/ui";
import Link from "next/link";
import { formatDateTime, queryValue } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { requirePage } from "@/lib/session";
import { helpForPage } from "@/guide";
import { moneySources } from "@/services/cash-book";
import { listTransfers, MOVES_PER_PAGE } from "@/services/transfers";

export const metadata: Metadata = { title: "Move money" };

const STATUS = {
  done: { label: "Done", tone: "good" },
  rejected: { label: "Refused", tone: "plain" },
  voided: { label: "Reversed", tone: "bad" },
  pending: { label: "Waiting", tone: "gold" },
} as const;

const DECIDED = { done: "Accepted", rejected: "Refused", voided: "Reversed", pending: "" } as const;

export default async function TransfersPage({ searchParams }: { searchParams: Promise<Record<string, unknown>> }) {
  const ctx = await requirePage("finance.view");
  const asked = Number(queryValue((await searchParams).page));
  const [{ pending, recent, userId, canMove, isManager, page, pages, total, held }, people] = await Promise.all([
    listTransfers(ctx, { page: Number.isFinite(asked) ? asked : 1, move: queryValue((await searchParams).move) }),
    moneySources(ctx),
  ]);
  const first = (page - 1) * MOVES_PER_PAGE + 1;
  const from = isManager ? people : people.filter((person) => person.id === userId);

  return (
    <>
      <PageHeader title="Move money" help={helpForPage(ctx.actor.role, "/transfers")?.id} subtitle="Banking cash, staff handovers and cash handed to the Owner" back={{ href: "/money", label: "Money" }} />
      <div className="space-y-4">
        {pending.length > 0 ? (
          <Card title="Handovers waiting">
            <ul className="space-y-4">
              {pending.map((item) => {
                const mine = item.confirmer === userId;
                const canWithdraw = !mine && (item.createdBy === userId || item.fromCustodian === userId);
                return (
                  <li key={item.id} id={`move-${item.id}`} className="scroll-mt-24 space-y-2">
                    <div className="font-semibold">{formatNaira(item.amountKobo)}</div>
                    <div className="text-sm text-muted">{item.fromLabel} to {item.toLabel}</div>
                    <div className="text-sm text-muted">
                      Recorded by {item.createdByName} · waiting for {item.confirmerName} to {item.giverConfirms ? "confirm they gave it" : "accept it"}
                    </div>
                    {item.note ? <div className="text-sm">{item.note}</div> : null}
                    {mine ? (
                      <ActionForm action={acceptTransferAction.bind(null, item.id)}>
                        <SubmitButton>{item.giverConfirms ? "I gave this cash" : "I received this cash"}</SubmitButton>
                      </ActionForm>
                    ) : null}
                    {mine || canWithdraw ? (
                      <Disclosure label={mine ? "Refuse" : "Withdraw"}>
                        <ActionForm action={rejectTransferAction.bind(null, item.id)}>
                          <TextareaField name="reason" label="Reason" />
                          <SubmitButton tone="plain">Confirm</SubmitButton>
                        </ActionForm>
                      </Disclosure>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </Card>
        ) : null}

        {canMove ? (
          <Card title="Record a move">
            <TransferForm from={from} people={people} isManager={isManager} me={userId} held={held} />
          </Card>
        ) : null}

        <Card title="Recent moves">
          {recent.length === 0 ? (
            <Empty>{total > 0 ? "There are no moves on this page." : "No money has been moved yet."}</Empty>
          ) : (
            <>
            <p className="mb-3 text-sm text-muted">
              Showing {first}–{first + recent.length - 1} of {total}, newest first.
            </p>
            <ul className="divide-y divide-line">
              {recent.map((item) => (
                <li key={item.id} id={`move-${item.id}`} className="scroll-mt-24 space-y-1.5 py-3 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-between gap-3">
                    <span className="font-semibold tabular-nums">{formatNaira(item.amountKobo)}</span>
                    <Badge tone={STATUS[item.status].tone}>{STATUS[item.status].label}</Badge>
                  </div>
                  <div className="text-sm">{item.fromLabel} to {item.toLabel}</div>
                  <div className="text-sm text-muted">
                    {formatDateTime(item.createdAt)} · {item.createdByName}
                    {item.reference ? ` · ${item.reference}` : ""}
                  </div>
                  {item.note ? <div className="text-sm">{item.note}</div> : null}
                  {item.decidedByName && item.decidedAt ? (
                    <div className="text-sm text-muted">
                      {DECIDED[item.status]} by {item.decidedByName} · {formatDateTime(item.decidedAt)}
                    </div>
                  ) : null}
                  {item.reason ? <div className="text-sm text-muted">Reason: {item.reason}</div> : null}
                  {item.photoId ? (
                    <a href={`/api/photos/${item.photoId}`} target="_blank" rel="noopener noreferrer" className="text-sm text-gold-deep underline">View teller</a>
                  ) : null}
                  {isManager && item.status === "done" ? (
                    <Disclosure label="Reverse this move">
                      <ActionForm action={voidTransferAction.bind(null, item.id)}>
                        <TextareaField name="reason" label="Reason" />
                        <SubmitButton tone="plain">Reverse</SubmitButton>
                      </ActionForm>
                    </Disclosure>
                  ) : null}
                </li>
              ))}
            </ul>
            </>
          )}
          {pages > 1 ? (
            <nav aria-label="Pages of moves" className="mt-4 flex items-center justify-between gap-3 text-sm">
              {page > 1 ? (
                <Link href={page === 2 ? "/transfers" : `/transfers?page=${page - 1}`} className="min-h-11 content-center font-semibold text-gold-deep underline">
                  Newer
                </Link>
              ) : <span />}
              <span className="text-muted">Page {page} of {pages}</span>
              {page < pages ? (
                <Link href={`/transfers?page=${page + 1}`} className="min-h-11 content-center font-semibold text-gold-deep underline">
                  Older
                </Link>
              ) : <span />}
            </nav>
          ) : null}
        </Card>
      </div>
    </>
  );
}
