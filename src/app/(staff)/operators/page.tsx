import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight, Plus, UserCheck, Users } from "lucide-react";
import { Badge, Empty, LinkButton, operatorTone, PageHeader, SearchBar } from "@/components/ui";
import { OPERATOR_STATUS_LABELS, queryValue } from "@/lib/format";
import { can } from "@/lib/permissions";
import { formatPhone } from "@/lib/phone";
import { requirePage } from "@/lib/session";
import { listOperators, NO_LOGIN } from "@/services/operators";

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
  const canManage = can(ctx.actor.role, "operator.manage");

  return (
    <>
      <PageHeader
        title="Operators"
        subtitle="Everyone who rides a Jayngol tricycle"
        action={
          canManage ? (
            <LinkButton href="/operators/new" variant="gold">
              <Plus size={16} />
              <span>Add operator</span>
            </LinkButton>
          ) : undefined
        }
      />
      <SearchBar
        q={q}
        status={status}
        placeholder="Search name, phone or tricycle code"
        options={canManage ? { ...OPERATOR_STATUS_LABELS, [NO_LOGIN]: "No portal login" } : OPERATOR_STATUS_LABELS}
      />
      {rows.length === 0 ? (
        <Empty>No operators match your query.</Empty>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line bg-card">
          <ul className="divide-y divide-line/60">
            {rows.map((o) => (
              <li key={o.id}>
                <Link
                  href={`/operators/${o.id}`}
                  className="group flex min-h-16 items-center gap-3 px-4 py-3.5 transition-colors duration-150 hover:bg-card-subtle"
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-card-subtle text-muted" aria-hidden>
                    {o.name.charAt(0)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <span className="min-w-0 text-base font-semibold leading-snug tracking-tight text-ink">{o.name}</span>
                      <Badge tone={operatorTone(o.status)} dot>
                        {OPERATOR_STATUS_LABELS[o.status]}
                      </Badge>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium text-muted">
                      {o.tricycleCode ? (
                        <span className="rounded-md border border-gold-light/40 bg-gold-wash px-2 py-0.5 font-bold text-gold-deep">
                          {o.tricycleCode}
                        </span>
                      ) : (
                        <span className="rounded-md bg-line/50 px-2 py-0.5 font-semibold">No tricycle</span>
                      )}
                      <span className="tabular-nums text-ink">{formatPhone(o.phone)}</span>
                      {canManage && o.status === "active" && !o.hasPortalLogin ? <span>No portal login</span> : null}
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
    </>
  );
}
