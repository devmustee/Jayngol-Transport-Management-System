import type { Metadata } from "next";
import Link from "next/link";
import { Bike, ChevronRight, Plus } from "lucide-react";
import { Badge, Empty, LinkButton, PageHeader, SearchBar, tricycleTone } from "@/components/ui";
import { formatDate, queryValue, TRICYCLE_STATUS_LABELS } from "@/lib/format";
import { can } from "@/lib/permissions";
import { requirePage } from "@/lib/session";
import { LIST_LIMIT, listTricycles } from "@/services/tricycles";

export const metadata: Metadata = { title: "Tricycles" };

export default async function TricyclesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, unknown>>;
}) {
  const ctx = await requirePage("tricycle.view");
  const params = await searchParams;
  const q = queryValue(params.q);
  const status = queryValue(params.status);
  const rows = await listTricycles(ctx, { q, status });

  return (
    <>
      <PageHeader
        title="Fleet Tricycles"
        subtitle="Manage fleet assignments, status and registration"
        action={
          can(ctx.actor.role, "tricycle.manage") ? (
            <LinkButton href="/tricycles/new" variant="gold">
              <Plus size={16} />
              <span>Add Tricycle</span>
            </LinkButton>
          ) : undefined
        }
      />
      <SearchBar
        q={q}
        status={status}
        placeholder="Search code, plate number or operator"
        options={TRICYCLE_STATUS_LABELS}
      />
      {rows.length === 0 ? (
        <Empty>No tricycles match your search filter.</Empty>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line bg-card shadow-premium">
          <ul className="divide-y divide-line/60">
            {rows.map((t) => (
              <li key={t.id}>
                <Link
                  href={`/tricycles/${t.id}`}
                  className="group flex min-h-16 items-center gap-3 px-4 py-3.5 transition-all duration-150 hover:bg-gold-wash/40"
                >
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-gold-light/40 bg-gold-wash/40 text-gold-deep transition-transform group-hover:scale-105" aria-hidden>
                    <Bike size={20} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-base font-extrabold tracking-tight text-ink">{t.codeNumber}</span>
                        <span className="rounded-md bg-line/50 px-2 py-0.5 text-xs font-semibold whitespace-nowrap text-muted">
                          {t.registrationNumber}
                        </span>
                      </span>
                      <Badge tone={tricycleTone(t.status)} dot>
                        {TRICYCLE_STATUS_LABELS[t.status]}
                      </Badge>
                    </div>
                    <div className="mt-1 text-xs font-medium leading-snug text-muted">
                      {t.operatorName ? (
                        <>
                          <strong className="text-ink">{t.operatorName}</strong> · since {formatDate(t.issuedOn!)}
                        </>
                      ) : (
                        <>In depot · bought {formatDate(t.purchasedOn)}</>
                      )}
                    </div>
                  </div>
                  <ChevronRight
                    size={18}
                    className="shrink-0 text-muted/60 transition-transform group-hover:translate-x-0.5 group-hover:text-gold-deep"
                    aria-hidden
                  />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {rows.length === LIST_LIMIT ? (
        <p className="mt-3 text-xs font-medium text-muted text-center">
          Showing first {LIST_LIMIT} tricycles. Use search to narrow down records.
        </p>
      ) : null}
    </>
  );
}
