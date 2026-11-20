import type { Metadata } from "next";
import Link from "next/link";
import { Empty, PageHeader } from "@/components/ui";
import { helpForPage } from "@/guide";
import { AUDIT_GROUPS, auditActionLabel } from "@/lib/audit-actions";
import { formatDateTime, queryValue } from "@/lib/format";
import { ROLE_LABELS } from "@/lib/permissions";
import { requirePage } from "@/lib/session";
import { AUDIT_PER_PAGE, listAudit } from "@/services/audit";

export const metadata: Metadata = { title: "Audit log" };

const INPUT = "mt-1 min-h-11 w-full min-w-0 rounded-lg border border-line bg-card px-3 text-base";

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, unknown>> }) {
  const ctx = await requirePage("audit.view");
  const params = await searchParams;
  const asked = Number(queryValue(params.page));
  const result = await listAudit(ctx, {
    who: queryValue(params.who),
    what: queryValue(params.what),
    from: queryValue(params.from),
    to: queryValue(params.to),
    q: queryValue(params.q),
    page: Number.isFinite(asked) ? asked : 1,
  });
  const { rows, total, page, pages, people, filter, filtered } = result;
  const first = (page - 1) * AUDIT_PER_PAGE + 1;

  /** The same search on another page. */
  const pageHref = (target: number) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) if (value) search.set(key, value);
    if (target > 1) search.set("page", String(target));
    const text = search.toString();
    return text ? `/audit?${text}` : "/audit";
  };

  return (
    <>
      <PageHeader
        title="Audit log"
        help={helpForPage(ctx.actor.role, "/audit")?.id}
        subtitle="Who did what, and when. This record cannot be changed."
      />
      <form className="mb-4 grid grid-cols-2 items-end gap-3 rounded-xl border border-line bg-card p-4 lg:grid-cols-6" role="search">
        <label className="col-span-2 min-w-0 font-medium lg:col-span-2">
          Search
          <input
            type="search"
            name="q"
            defaultValue={filter.q ?? ""}
            placeholder="Name, reason or action"
            maxLength={60}
            autoComplete="off"
            className={INPUT}
          />
        </label>
        <label className="col-span-2 min-w-0 font-medium sm:col-span-1">
          Who
          <select name="who" defaultValue={filter.who ?? ""} className={INPUT}>
            <option value="">Anyone</option>
            <option value="system">System (the app itself)</option>
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
                {person.status === "active" ? "" : " (disabled)"}
              </option>
            ))}
          </select>
        </label>
        <label className="col-span-2 min-w-0 font-medium sm:col-span-1">
          What
          <select name="what" defaultValue={filter.what ?? ""} className={INPUT}>
            <option value="">Everything</option>
            {AUDIT_GROUPS.map((group, index) => (
              <optgroup key={group.label} label={group.label}>
                <option value={`group:${index}`}>All {group.label.toLowerCase()}</option>
                {Object.entries(group.actions).map(([action, label]) => (
                  <option key={action} value={action}>
                    {label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="min-w-0 font-medium">
          From
          <input type="date" name="from" defaultValue={filter.from ?? ""} className={INPUT} />
        </label>
        <label className="min-w-0 font-medium">
          To
          <input type="date" name="to" defaultValue={filter.to ?? ""} className={INPUT} />
        </label>
        <div className="col-span-2 flex flex-wrap items-center gap-3 lg:col-span-6">
          <button className="min-h-11 rounded-lg bg-ink px-5 font-semibold text-gold-light">Search</button>
          {filtered ? (
            <Link href="/audit" className="min-h-11 content-center font-semibold text-gold-deep underline">
              Clear
            </Link>
          ) : null}
        </div>
      </form>

      {rows.length === 0 ? (
        <Empty>
          {filtered ? "Nothing matches this search." : total > 0 ? "There is nothing on this page." : "Nothing recorded yet."}
        </Empty>
      ) : (
        <>
          <p className="mb-2 text-sm text-muted" aria-live="polite">
            Showing {first}–{first + rows.length - 1} of {total}
            {filtered ? " that match" : ""}, newest first.
          </p>
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
            {rows.map((row) => (
              <li key={row.id} className="p-3">
                <div className="font-semibold">{auditActionLabel(row.action)}</div>
                <div className="text-sm text-muted">
                  {row.actorName ?? "System"}
                  {row.actorRole ? ` (${ROLE_LABELS[row.actorRole]})` : ""} · {formatDateTime(row.occurredAt)}
                </div>
                {row.reason ? <div className="mt-1 text-sm">{row.reason}</div> : null}
              </li>
            ))}
          </ul>
        </>
      )}

      {pages > 1 ? (
        <nav aria-label="Pages of the audit log" className="mt-4 flex items-center justify-between gap-3 text-sm">
          {page > 1 ? (
            <Link href={pageHref(page - 1)} className="min-h-11 content-center font-semibold text-gold-deep underline">
              Newer
            </Link>
          ) : (
            <span />
          )}
          <span className="text-muted">
            Page {Math.min(page, pages)} of {pages}
          </span>
          {page < pages ? (
            <Link href={pageHref(page + 1)} className="min-h-11 content-center font-semibold text-gold-deep underline">
              Older
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </>
  );
}
