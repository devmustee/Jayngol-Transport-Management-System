import type { Metadata } from "next";
import Link from "next/link";
import { confirmViolationAction, rejectViolationAction, waiveViolationAction } from "@/app/actions";
import { ActionForm, SubmitButton, TextareaField } from "@/components/form";
import { FinesOwed } from "@/components/fines-owed";
import { Badge, Card, Disclosure, Empty, LinkButton, PageHeader, SearchBar } from "@/components/ui";
import { formatDate, formatDateTime, OPERATOR_STATUS_LABELS, queryValue, VIOLATION_STATUS_LABELS } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { formatPhone } from "@/lib/phone";
import { requirePage } from "@/lib/session";
import { operatorsOwingFines } from "@/services/payments";
import { listViolations, RULE_NAMES } from "@/services/violations";
import { helpForPage } from "@/guide";

export const metadata: Metadata = { title: "Offences" };

const TONE = { proposed: "gold", confirmed: "bad", rejected: "plain", waived: "plain" } as const;
const DECISION = { proposed: null, confirmed: "Confirmed", rejected: "Rejected", waived: "Waived" } as const;

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

export default async function OffencesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, unknown>>;
}) {
  const ctx = await requirePage("violation.view");
  const query = await searchParams;
  const status = queryValue(query.status);
  const q = queryValue(query.q)?.trim().slice(0, 60) ?? "";
  const canCollect = can(ctx.actor.role, "payment.record");
  const [{ rows, page, hasMore, total }, owing] = await Promise.all([
    listViolations(ctx, status, Number(queryValue(query.page) ?? 1), q),
    // Fines are paid here, per operator, apart from the daily balance.
    !q && (!status || status === "confirmed") ? operatorsOwingFines(ctx) : Promise.resolve([]),
  ]);
  const href = (next: { status?: string; page?: number; q?: string }) => {
    const params = new URLSearchParams();
    if (next.q) params.set("q", next.q);
    if (next.status) params.set("status", next.status);
    if (next.page && next.page > 1) params.set("page", String(next.page));
    const text = params.toString();
    return text ? `/offences?${text}` : "/offences";
  };
  const pageHref = (to: number) => href({ status, q, page: to });
  const canDecide = can(ctx.actor.role, "violation.confirm");
  const canWaive = can(ctx.actor.role, "violation.waive");

  return (
    <>
      <PageHeader
        help={helpForPage(ctx.actor.role, "/offences")?.id}
        title="Offences"
        action={can(ctx.actor.role, "violation.raise") ? <LinkButton href="/offences/late-work">Record late work</LinkButton> : undefined}
      />
      {owing.length > 0 ? (
        <Card title="Fines owed" subtitle="Paid here, separately from the daily balance." className="mb-4">
          <FinesOwed
            canCollect={canCollect}
            canWaive={canWaive}
            owing={owing.map((o) => ({
              operatorId: o.operatorId,
              name: o.name,
              phone: o.phone,
              statusLabel:
                o.status === "active"
                  ? null
                  : (OPERATOR_STATUS_LABELS[o.status as keyof typeof OPERATOR_STATUS_LABELS] ?? o.status),
              tricycle: o.tricycle,
              fines: o.fines,
              owedKobo: o.owedKobo,
              oldest: o.oldest,
              items: o.items.map((f) => ({
                chargeId: f.chargeId,
                offence: f.ruleCode ? (RULE_NAMES[f.ruleCode] ?? f.ruleCode) : "Fine",
                date: f.date,
                amountKobo: f.amountKobo,
                outstandingKobo: f.outstandingKobo,
                code: f.code,
                registration: f.registration,
              })),
            }))}
          />
        </Card>
      ) : null}
      <SearchBar q={q} placeholder="Search operator, phone, tricycle, plate or offence" keep={{ status }} />
      <nav className="mb-4 flex flex-wrap gap-2" aria-label="Filter">
        {[["", "All"], ...Object.entries(VIOLATION_STATUS_LABELS)].map(([value, label]) => (
          <Link
            key={value}
            href={href({ status: value, q })}
            aria-current={(status ?? "") === value ? "page" : undefined}
            className="inline-flex min-h-11 items-center rounded-full border border-line bg-card px-4 font-medium aria-[current=page]:bg-ink aria-[current=page]:text-gold-light"
          >
            {label}
          </Link>
        ))}
      </nav>
      {q ? (
        <p className="mb-4 text-sm text-muted" aria-live="polite">
          {total === 0 ? `No offences match "${q}".` : `${total} offence${total === 1 ? "" : "s"} match "${q}".`}{" "}
          <Link href={href({ status })} className="inline-flex min-h-11 items-center font-semibold text-gold-deep underline underline-offset-2">
            Clear search
          </Link>
        </p>
      ) : null}
      {rows.length === 0 ? (
        q ? null : <Empty help={helpForPage(ctx.actor.role, "/offences")?.id}>No offences here.</Empty>
      ) : (
        <div className="space-y-3">
          {rows.map((v) => (
            <Card key={v.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="font-bold leading-snug">{RULE_NAMES[v.ruleCode] ?? v.ruleCode}</h2>
                  <div className="text-sm text-muted">
                    {formatDate(v.occurredOn)} · <span className="font-semibold tabular-nums text-ink">{formatNaira(v.amountKobo)}</span>
                  </div>
                </div>
                <Badge tone={TONE[v.status]}>{VIOLATION_STATUS_LABELS[v.status]}</Badge>
              </div>
              <dl className="mt-3 grid gap-3 border-t border-line pt-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
                <Fact label="Operator">
                  <Link href={`/operators/${v.operatorId}`} className="font-semibold text-gold-deep underline underline-offset-2">
                    {v.operatorName}
                  </Link>
                  <div>
                    <a href={`tel:${v.operatorPhone}`} className="text-muted hover:text-ink hover:underline">
                      {formatPhone(v.operatorPhone)}
                    </a>
                  </div>
                </Fact>
                <Fact label="Tricycle">
                  {v.tricycleId ? (
                    <>
                      <Link href={`/tricycles/${v.tricycleId}`} className="font-semibold text-gold-deep underline underline-offset-2">
                        {v.tricycleCode}
                      </Link>
                      <div className="text-muted">Registration {v.registrationNumber}</div>
                    </>
                  ) : (
                    <span className="text-muted">Not recorded</span>
                  )}
                </Fact>
                <Fact label="Recorded">
                  {v.raisedByName ? `By ${v.raisedByName}` : "By the system"}
                  <div className="text-muted">{formatDateTime(v.recordedAt)}</div>
                </Fact>
                {DECISION[v.status] ? (
                  <Fact label={DECISION[v.status]!}>
                    {v.decidedByName ? `By ${v.decidedByName}` : "By the system"}
                    {v.decidedAt ? <div className="text-muted">{formatDateTime(v.decidedAt)}</div> : null}
                  </Fact>
                ) : null}
                {v.note ? <Fact label="Note">{v.note}</Fact> : null}
                {v.decisionReason ? <Fact label="Reason">{v.decisionReason}</Fact> : null}
              </dl>
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
