import type { Metadata } from "next";
import Link from "next/link";
import { TakeOutForm, type TakeOutJob } from "@/components/forms/take-out-form";
import { Empty, PageHeader } from "@/components/ui";
import { WORK_TYPE_LABELS } from "@/lib/format";
import { can } from "@/lib/permissions";
import { requirePage } from "@/lib/session";
import { openJobsForParts, partsToIssue } from "@/services/store";

export const metadata: Metadata = { title: "Take out items" };

const timeFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Africa/Lagos",
});

export default async function TakeOutPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requirePage("stock.move");
  const { item, job } = await searchParams;
  const [jobs, items] = await Promise.all([openJobsForParts(ctx), partsToIssue(ctx)]);

  const choices: TakeOutJob[] = jobs.map((j) => ({
    id: j.id,
    code: j.code,
    detail: [
      WORK_TYPE_LABELS[j.type],
      j.checkedInAt ? `checked in ${timeFormat.format(j.checkedInAt)}` : null,
      j.fault,
    ]
      .filter(Boolean)
      .join(" · "),
  }));

  return (
    <>
      <PageHeader
        title="Take out items"
        subtitle="From the store to a tricycle in the workshop"
        back={{ href: "/store", label: "Store" }}
      />
      {choices.length === 0 ? (
        <Empty>
          No tricycle is in the workshop. Check one in from{" "}
          <Link href="/workshop" className="font-semibold text-gold-deep underline">
            Workshop
          </Link>{" "}
          first, then take out what it needs.
        </Empty>
      ) : items.length === 0 ? (
        <Empty>The store is empty. Receive stock on an item first.</Empty>
      ) : (
        <TakeOutForm
          jobs={choices}
          items={items.map((i) => ({
            id: i.id,
            name: i.name,
            unit: i.unit,
            wholeOnly: i.wholeOnly,
            quantityMilli: i.quantityMilli,
            valueKobo: i.valueKobo,
          }))}
          jobId={choices.some((c) => c.id === job) ? job : undefined}
          focusItemId={item}
          showCost={can(ctx.actor.role, "workorder.cost")}
        />
      )}
    </>
  );
}
