import type { Metadata } from "next";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { ROLE_LABELS } from "@/lib/permissions";
import { requirePage } from "@/lib/session";
import { tourReport } from "@/services/guide-progress";

export const metadata: Metadata = { title: "Tours taken" };

const STATE = {
  done: { label: "Finished", tone: "good" },
  skipped: { label: "Skipped", tone: "warning" },
  not_yet: { label: "Not yet", tone: "plain" },
} as const;

/** For the Owner and Manager: who has taken the Guide's tours, so help can go where it is needed. */
export default async function ToursTakenPage() {
  const ctx = await requirePage("guide.progress");
  const { staff, tours } = await tourReport(ctx);

  return (
    <>
      <PageHeader
        title="Tours taken"
        subtitle="Which staff have finished or skipped each tour in the Guide"
        back={{ href: "/guide", label: "Guide" }}
      />
      {staff.length === 0 ? (
        <Empty>No working staff logins.</Empty>
      ) : (
        <div className="space-y-4">
          <Card title="Each tour">
            <ul className="divide-y divide-line">
              {tours.map((tour) => (
                <li key={tour.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5">
                  <span className="font-semibold text-ink">{tour.title}</span>
                  <span className="text-sm text-muted tabular-nums">
                    {tour.done} of {tour.offered} finished{tour.skipped > 0 ? `, ${tour.skipped} skipped` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Each person" subtitle="Only the tours for each person's work are listed.">
            <ul className="divide-y divide-line">
              {staff.map((person) => (
                <li key={person.id} className="py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="font-semibold text-ink">{person.name}</span>
                    <span className="text-xs text-muted">
                      {ROLE_LABELS[person.role]}
                      {person.lastLoginAt ? ` · last in ${formatDateTime(person.lastLoginAt)}` : " · never logged in"}
                    </span>
                  </div>
                  <ul className="mt-2 space-y-1.5">
                    {person.tours.map((tour) => (
                      <li key={tour.id} className="flex items-center justify-between gap-3 text-sm">
                        <span className="min-w-0 text-ink-muted">{tour.title}</span>
                        <span className="flex shrink-0 items-center gap-2">
                          {tour.at ? <span className="hidden text-xs text-muted sm:inline">{formatDateTime(tour.at)}</span> : null}
                          <Badge tone={STATE[tour.status].tone}>{STATE[tour.status].label}</Badge>
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}
