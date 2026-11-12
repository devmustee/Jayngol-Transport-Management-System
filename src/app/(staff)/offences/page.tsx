import type { Metadata } from "next";
import Link from "next/link";
import { confirmViolationAction, rejectViolationAction, waiveViolationAction } from "@/app/actions";
import { ActionForm, SubmitButton, TextareaField } from "@/components/form";
import { Badge, Card, Disclosure, Empty, LinkButton, PageHeader } from "@/components/ui";
import { formatDate, queryValue, VIOLATION_STATUS_LABELS } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { requirePage } from "@/lib/session";
import { operatorsOwingFines } from "@/services/payments";
import { listViolations, RULE_NAMES } from "@/services/violations";

export const metadata: Metadata = { title: "Offences" };

const TONE = { proposed: "gold", confirmed: "bad", rejected: "plain", waived: "plain" } as const;

export default async function OffencesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, unknown>>;
}) {
  const ctx = await requirePage("violation.view");
  const query = await searchParams;
  const status = queryValue(query.status);
  const canCollect = can(ctx.actor.role, "payment.record");
  const [{ rows, page, hasMore }, owing] = await Promise.all([
    listViolations(ctx, status, Number(queryValue(query.page) ?? 1)),
    // Fines are paid here, per operator, apart from the daily balance.
    !status || status === "confirmed" ? operatorsOwingFines(ctx) : Promise.resolve([]),
  ]);
  const pageHref = (to: number) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (to > 1) params.set("page", String(to));
    const text = params.toString();
    return text ? `/offences?${text}` : "/offences";
  };
  const canDecide = can(ctx.actor.role, "violation.confirm");
  const canWaive = can(ctx.actor.role, "violation.waive");

  return (
    <>
      <PageHeader
        title="Offences"
        action={can(ctx.actor.role, "violation.raise") ? <LinkButton href="/offences/late-work">Record late work</LinkButton> : undefined}
      />
      {owing.length > 0 ? (
        <Card title="Fines owed" subtitle="Paid here, separately from the daily balance." className="mb-4">
          <ul className="divide-y divide-line">
            {owing.map((o) => (
              <li key={o.operatorId} className="flex min-h-12 items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <Link href={`/operators/${o.operatorId}`} className="font-medium text-ink hover:underline">
                    {o.name}
                  </Link>
                  <div className="text-sm text-muted">
                    {o.fines} fine{o.fines === 1 ? "" : "s"} · {formatNaira(o.owedKobo)}
                  </div>
                </div>
                {canCollect ? (
                  <LinkButton href={`/payments/new?operator=${o.operatorId}&for=fines`} variant="secondary">
                    Pay fines
                  </LinkButton>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <nav className="mb-4 flex flex-wrap gap-2" aria-label="Filter">
        {[["", "All"], ...Object.entries(VIOLATION_STATUS_LABELS)].map(([value, label]) => (
          <Link
            key={value}
            href={value ? `/offences?status=${value}` : "/offences"}
            aria-current={(status ?? "") === value ? "page" : undefined}
            className="inline-flex min-h-11 items-center rounded-full border border-line bg-card px-4 font-medium aria-[current=page]:bg-ink aria-[current=page]:text-gold-light"
          >
            {label}
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? (
        <Empty>No offences here.</Empty>
      ) : (
        <div className="space-y-3">
          {rows.map((v) => (
            <Card key={v.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link href={`/operators/${v.operatorId}`} className="font-bold text-gold-deep underline">{v.operatorName}</Link>
                  <div>{RULE_NAMES[v.ruleCode] ?? v.ruleCode}</div>
                  <div className="text-sm text-muted">
                    {formatDate(v.occurredOn)}
                    {v.tricycleCode ? ` · ${v.tricycleCode}` : ""} · {formatNaira(v.amountKobo)}
                  </div>
                  {v.raisedByName ? <div className="text-sm text-muted">Raised by {v.raisedByName}</div> : null}
                  {v.note ? <div className="mt-1 text-sm">{v.note}</div> : null}
                  {v.decisionReason ? <div className="mt-1 text-sm">{v.decisionReason}</div> : null}
                  {v.photoId ? (
                    <a href={`/api/photos/${v.photoId}`} target="_blank" rel="noreferrer" className="mt-2 block w-fit">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`/api/photos/${v.photoId}`} alt="Evidence" loading="lazy" className="h-20 rounded-lg border border-line" />
                    </a>
                  ) : null}
                </div>
                <Badge tone={TONE[v.status]}>{VIOLATION_STATUS_LABELS[v.status]}</Badge>
              </div>
              {v.status === "proposed" && canDecide ? (
                <div className="mt-3 space-y-3">
                  {v.raisedBy === ctx.actor.userId ? (
                    <p className="text-sm text-muted">You raised this, so someone else must confirm it.</p>
                  ) : (
                    <ActionForm action={confirmViolationAction.bind(null, v.id)}>
                      <SubmitButton>Confirm and add fine</SubmitButton>
                    </ActionForm>
                  )}
                  <Disclosure label="Reject">
                    <ActionForm action={rejectViolationAction.bind(null, v.id)}>
                      <TextareaField name="reason" label="Reason" />
                      <SubmitButton tone="plain">Reject offence</SubmitButton>
                    </ActionForm>
                  </Disclosure>
                </div>
              ) : null}
              {v.status === "confirmed" && canWaive ? (
                <div className="mt-3">
                  <Disclosure label="Waive fine">
                    <ActionForm action={waiveViolationAction.bind(null, v.id)}>
                      <TextareaField name="reason" label="Reason" />
                      <SubmitButton tone="plain">Waive fine</SubmitButton>
                    </ActionForm>
                  </Disclosure>
                </div>
              ) : null}
            </Card>
          ))}
        </div>
      )}
      {page > 1 || hasMore ? (
        <nav className="mt-4 flex items-center justify-between gap-3" aria-label="Pages">
          {page > 1 ? <LinkButton href={pageHref(page - 1)} variant="secondary">Newer</LinkButton> : <span />}
          <span className="text-sm text-muted">Page {page}</span>
          {hasMore ? <LinkButton href={pageHref(page + 1)} variant="secondary">Older</LinkButton> : <span />}
        </nav>
      ) : null}
    </>
  );
}
