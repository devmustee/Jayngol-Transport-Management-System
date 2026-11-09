import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight, Plus, UserCheck, Users } from "lucide-react";
import { Badge, Empty, LinkButton, operatorTone, PageHeader, SearchBar } from "@/components/ui";
import { OPERATOR_STATUS_LABELS, queryValue } from "@/lib/format";
import { can } from "@/lib/permissions";
import { formatPhone } from "@/lib/phone";
import { requirePage } from "@/lib/session";
import { listOperators } from "@/services/operators";

export const metadata: Metadata = { title: "Operators" };

export default async function OperatorsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, unknown>>;
}) {
  const ctx = await requirePage("operator.view");
  const params = await searchParams;
  const q = queryValue(params.q);
  const status = queryValue(params.status);
  const rows = await listOperators(ctx, { q, status });

  return (
    <>
      <PageHeader
        title="Fleet Drivers & Operators"
        subtitle="Driver accounts, daily hire agreements and contact details"
        action={
          can(ctx.actor.role, "operator.manage") ? (
            <LinkButton href="/operators/new" variant="gold">
              <Plus size={16} />
              <span>Add Operator</span>
            </LinkButton>
          ) : undefined
        }
      />
      <SearchBar
        q={q}
        status={status}
        placeholder="Search name, phone or tricycle code"
        options={OPERATOR_STATUS_LABELS}
      />
      {rows.length === 0 ? (
        <Empty>No operators match your query.</Empty>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line bg-card shadow-premium">
          <ul className="divide-y divide-line/60">
            {rows.map((o) => (
              <li key={o.id}>
                <Link
                  href={`/operators/${o.id}`}
                  className="group flex min-h-16 items-center justify-between gap-3 p-4 transition-all duration-150 hover:bg-gold-wash/40"
                >
                  <div className="flex items-center gap-3.5 min-w-0">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-ink-soft border border-gold-deep/20 text-gold-light font-bold text-sm transition-transform group-hover:scale-105">
                      {o.name.charAt(0)}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-extrabold text-ink text-base tracking-tight truncate">
                          {o.name}
                        </span>
                        {o.tricycleCode ? (
                          <span className="rounded-md bg-gold-wash border border-gold-light/40 px-2 py-0.5 text-xs font-bold text-gold-deep">
                            {o.tricycleCode}
                          </span>
                        ) : (
                          <span className="rounded-md bg-line/50 px-2 py-0.5 text-xs font-semibold text-muted">
                            Unassigned
                          </span>
                        )}
                      </div>
                      <div className="truncate text-xs font-medium text-muted mt-0.5">
                        Tel: <span className="text-ink">{formatPhone(o.phone)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    <Badge tone={operatorTone(o.status)} dot>
                      {OPERATOR_STATUS_LABELS[o.status]}
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
    </>
  );
}
