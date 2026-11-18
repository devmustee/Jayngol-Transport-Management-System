import { finishBackEntriesAction, openBackEntriesAction } from "@/app/actions";
import { ActionForm, Field, SubmitButton } from "@/components/form";
import { Disclosure } from "@/components/ui";
import { addDays } from "@/lib/clock";
import { formatDate, formatShortDate } from "@/lib/format";
import type { backEntryStatus } from "@/services/back-entries";

/** Opens and finishes the hold on fines while late payments are entered. */
export function BackEntriesCard({ status }: { status: Awaited<ReturnType<typeof backEntryStatus>> }) {
  const { window, canManage, today, maxStopOn } = status;
  if (window) {
    const span =
      window.fromDate === window.untilDate
        ? formatShortDate(window.fromDate)
        : `${formatShortDate(window.fromDate)} to ${formatShortDate(window.untilDate)}`;
    return (
      <section className="mb-6 rounded-2xl border border-warning-border bg-warning-wash p-4 sm:p-5">
        <h2 className="text-base font-semibold text-ink">Back entries for {span} are open</h2>
        <p className="mt-1 text-sm text-ink">
          Fines for these days wait until back entries are finished, or until {formatDate(window.stopOn)} at the latest.
          Payments entered with their real day count as on time.
        </p>
        {canManage ? (
          <ActionForm action={finishBackEntriesAction} className="mt-3">
            <SubmitButton>Back entries finished</SubmitButton>
          </ActionForm>
        ) : null}
      </section>
    );
  }
  if (!canManage) return null;
  return (
    <div className="mb-6">
      <Disclosure label="Enter past days' payments late">
        <p className="mb-3 text-sm text-muted">
          While these days are open, nobody is fined for them. When you finish, the next nightly run fines only the days
          that were truly not paid on time.
        </p>
        <ActionForm action={openBackEntriesAction}>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field name="fromDate" label="First day" type="date" max={today} defaultValue={today} />
            <Field name="untilDate" label="Last day" type="date" max={today} defaultValue={today} />
            <Field
              name="stopOn"
              label="Fines wait until at the latest"
              type="date"
              min={addDays(today, 1)}
              max={maxStopOn}
              defaultValue={addDays(today, 7)}
            />
          </div>
          <SubmitButton>Open back entries</SubmitButton>
        </ActionForm>
      </Disclosure>
    </div>
  );
}
