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
                  className="group flex min-h-16 items-center justify-between gap-3 p-4 transition-all duration-150 hover:bg-gold-wash/40"
                >
                  <div className="flex items-center gap-3.5 min-w-0">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gold-wash/40 border border-gold-light/40 text-gold-deep transition-transform group-hover:scale-105">
                      <Bike size={20} />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-extrabold text-ink text-base tracking-tight">
                          {t.codeNumber}
                        </span>
                        <span className="rounded-md bg-line/50 px-2 py-0.5 text-xs font-semibold text-muted">
                          {t.registrationNumber}
                        </span>
                      </div>
                      <div className="truncate text-xs font-medium text-muted mt-0.5">
                        {t.operatorName ? (
                          <span>
                            Driver: <strong className="text-ink">{t.operatorName}</strong> • Since{" "}
                            {formatDate(t.issuedOn!)}
                          </span>
                        ) : (
                          <span>In depot • Purchased {formatDate(t.purchasedOn)}</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    <Badge tone={tricycleTone(t.status)} dot>
                      {TRICYCLE_STATUS_LABELS[t.status]}
                    </Badge>
                    <ChevronRight
                      size={18}
                      className="text-muted/60 transition-transform group-hover:translate-x-0.5 group-hover:text-gold-deep"
                      aria-hidden
                    />
                  </div>
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
