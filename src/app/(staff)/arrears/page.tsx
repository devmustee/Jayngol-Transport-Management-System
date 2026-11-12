import type { Metadata } from "next";
import Link from "next/link";
import { Wallet } from "lucide-react";
import { Badge, Empty, PageHeader } from "@/components/ui";
import { businessDate } from "@/lib/clock";
import { formatDate, formatShortDate, OPERATOR_STATUS_LABELS } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { can } from "@/lib/permissions";
import { parseRange } from "@/lib/periods";
import { formatPhone } from "@/lib/phone";
import { requirePage } from "@/lib/session";
import { listArrears } from "@/services/finance";

export const metadata: Metadata = { title: "Unpaid balances" };

type Row = Awaited<ReturnType<typeof listArrears>>[number];

const sumOwed = (rows: Row[]) => rows.reduce((sum, r) => sum + r.owed, 0);

function Group({
  title,
  rows,
  canCollect,
  today,
}: {
  title: string;
  rows: Row[];
  canCollect: boolean;
  today: string;
}) {
  if (rows.length === 0) return null;
  return (
    <section aria-label={title}>
      <div className="mb-2 flex items-baseline justify-between gap-3 px-1">
        <h2 className="text-sm font-medium text-muted">
          {title} ({rows.length})
        </h2>
        <span className="text-sm font-semibold tabular-nums text-ink">{formatNaira(sumOwed(rows))}</span>
      </div>
      <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-card">
        {rows.map((r) => {
          // Older days are paid from here; a day still owed today is taken on the day.
          const onlyToday = r.oldest >= today;
          return (
            <li key={r.id} className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto] sm:items-start sm:gap-6">
              {/* Operator */}
              <div className="min-w-0">
                <Link
                  href={`/operators/${r.id}`}
                  className="font-semibold leading-snug text-ink [overflow-wrap:anywhere] hover:underline"
                >
                  {r.name}
                </Link>
                {r.status !== "active" ? (
                  <span className="ml-2 align-middle">
                    <Badge tone="bad">{OPERATOR_STATUS_LABELS[r.status]}</Badge>
                  </span>
                ) : null}
                <dl className="mt-1 space-y-0.5 text-sm text-muted">
                  <div>
                    <dt className="sr-only">Phone</dt>
                    <dd>
                      <a href={`tel:${r.phone}`} className="hover:text-ink hover:underline">
                        {formatPhone(r.phone)}
                      </a>
                    </dd>
                  </div>
                  {r.address ? (
                    <div>
                      <dt className="sr-only">Address</dt>
                      <dd className="[overflow-wrap:anywhere]">{r.address}</dd>
                    </div>
                  ) : null}
                  {r.guarantor_name ? (
                    <div>
                      <dt className="inline">Guarantor: </dt>
                      <dd className="inline">
                        {r.guarantor_name}
                        {r.guarantor_phone ? (
                          <>
                            {" · "}
                            <a href={`tel:${r.guarantor_phone}`} className="hover:text-ink hover:underline">
                              {formatPhone(r.guarantor_phone)}
                            </a>
                          </>
                        ) : null}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </div>

              {/* Tricycle */}
              <div className="min-w-0 rounded-xl bg-card-subtle px-3 py-2 sm:bg-transparent sm:p-0">
                {r.tricycle_id ? (
                  <>
                    <Link href={`/tricycles/${r.tricycle_id}`} className="font-medium text-ink hover:underline">
                      {r.code_number}
                    </Link>
                    <span className="text-sm text-muted"> · {r.registration_number}</span>
                    <dl className="mt-1 space-y-0.5 text-sm text-muted">
                      {r.daily_kobo ? (
                        <div>
                          <dt className="inline">Daily balance: </dt>
                          <dd className="inline tabular-nums">{formatNaira(r.daily_kobo)}</dd>
                        </div>
                      ) : null}
                      <div>
                        <dt className="sr-only">Holder</dt>
                        <dd>{r.holds_tricycle ? "Still with this operator" : "No longer with this operator"}</dd>
                      </div>
                    </dl>
                  </>
                ) : (
                  <span className="text-sm text-muted">No tricycle</span>
                )}
              </div>

              {/* What is owed */}
              <div className="flex items-center justify-between gap-4 sm:flex-col sm:items-end sm:gap-2">
                <Link href={`/operators/${r.id}/statement`} className="group text-left sm:text-right">
                  <div className="font-semibold tabular-nums text-ink group-hover:underline">{formatNaira(r.owed)}</div>
                  <div className="text-xs text-muted">
                    {r.days} day{r.days === 1 ? "" : "s"} ·{" "}
                    {r.oldest === r.newest
                      ? formatDate(r.oldest)
                      : `${formatShortDate(r.oldest)} to ${formatDate(r.newest)}`}
                  </div>
                </Link>
                {canCollect ? (
                  <Link
                    href={onlyToday ? `/payments/new?operator=${r.id}` : `/payments/new?operator=${r.id}&for=balance`}
                    aria-label={`Take payment from ${r.name}`}
                    className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-gold px-4 text-sm font-semibold text-ink transition-colors hover:bg-gold-light active:scale-[0.98]"
                  >
                    <Wallet size={16} aria-hidden />
                    Take payment
                  </Link>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default async function ArrearsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const ctx = await requirePage("finance.view");
  const range = parseRange(await searchParams);
  const rows = await listArrears(ctx, range ?? undefined);
  const canCollect = can(ctx.actor.role, "payment.record");
  const today = businessDate(ctx.clock());
  const working = rows.filter((r) => r.status === "active");
  const gone = rows.filter((r) => r.status !== "active");
  const total = formatNaira(sumOwed(rows));
  return (
    <>
      <PageHeader
        title="Unpaid balances"
        subtitle={range ? `${total} for ${formatDate(range.from)} to ${formatDate(range.to)}` : `Total ${total}`}
        back={{ href: "/money", label: "Money" }}
      />
      {range ? (
        <p className="mb-3 text-sm text-muted">
          Only balances for these days.{" "}
          <Link href="/arrears" className="inline-flex min-h-11 items-center font-semibold text-gold-deep underline underline-offset-2">
            Show every unpaid balance
          </Link>
        </p>
      ) : null}
      {rows.length === 0 ? (
        <Empty>{range ? "Every balance for these days is paid." : "Every balance is paid."}</Empty>
      ) : (
        <div className="space-y-6">
          {canCollect ? (
            <p className="text-sm text-muted">
              Take payment here pays the days before today, oldest first. Today&apos;s balance is taken on the day from
              Take payment.
            </p>
          ) : null}
          <Group title="Working operators" rows={working} canCollect={canCollect} today={today} />
          <Group title="No longer working" rows={gone} canCollect={canCollect} today={today} />
        </div>
      )}
    </>
  );
}
