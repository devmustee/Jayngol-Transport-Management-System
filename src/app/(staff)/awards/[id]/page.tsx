import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { JourneyBar, MilestonePath, StageBadge, trackHeadline } from "@/components/award-tracker";
import { Card, Details, PageHeader } from "@/components/ui";
import type { AwardTrack } from "@/lib/award-progress";
import { isUuid } from "@/lib/fields";
import { AWARD_LABELS, AWARD_PRIZES, formatDate } from "@/lib/format";
import { can } from "@/lib/permissions";
import { requirePage } from "@/lib/session";
import { getOperatorJourney } from "@/services/award-tracker";

export const metadata: Metadata = { title: "Award journey" };

const BREAKS_SHOWN = 12;

/** The same things that would stop the award when the Manager decides it. */
function holdUps(track: AwardTrack): string[] {
  const reasons: string[] = [];
  if (track.closedReason) reasons.push(track.closedReason);
  if (track.underReview > 0) reasons.push(`${track.underReview} offence(s) still to be decided.`);
  if (track.coverage?.behind) {
    reasons.push(`Inspected on ${track.coverage.percent}% of working days so far. Needs at least 80%.`);
  }
  return reasons;
}

function AwardCard({ track }: { track: AwardTrack }) {
  const reasons = holdUps(track);
  return (
    <Card title={AWARD_LABELS[track.type]} subtitle={`Prize: ${AWARD_PRIZES[track.type]}`} action={<StageBadge stage={track.stage} />}>
      <p className="text-2xl font-semibold tracking-tight text-ink">{trackHeadline(track)}</p>
      {track.nextAwardOn ? (
        <>
          <p className="mt-0.5 text-sm font-medium text-muted">
            Award date {formatDate(track.nextAwardOn)}
            {track.journeyPercent === 0 ? ` · Counting starts ${formatDate(track.countingFrom!)}` : ""}
          </p>
          <div className="mt-3">
            <JourneyBar percent={track.journeyPercent} label={`${AWARD_LABELS[track.type]} journey`} />
          </div>
          <p className="mt-1.5 text-xs font-semibold text-muted">{track.journeyPercent}% of the 6 months</p>
        </>
      ) : null}
      {track.nextAwardOn && reasons.length > 0 ? (
        <ul className="mt-3 space-y-1 rounded-xl border border-warning-border bg-warning-wash px-3.5 py-2.5 text-sm font-semibold text-warning">
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

export default async function AwardJourneyPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePage("awards.track");
  const { id } = await params;
  const journey = isUuid(id) ? await getOperatorJourney(ctx, id) : null;
  if (!journey) notFound();
  const { progress } = journey;
  const canSeeBreaks = can(ctx.actor.role, "finance.view");

  return (
    <>
      <PageHeader title={journey.name} subtitle={journey.tricycleCode ?? "No tricycle at the moment"} back={{ href: "/awards", label: "Awards" }} />
      <div className="space-y-4">
        <Card>
          <Details
            rows={[
              ["Current run", `${progress.currentRunDays} days`],
              ["Personal best", `${progress.bestRunDays} days`],
              ["Run started", progress.runStartedOn ? formatDate(progress.runStartedOn) : null],
            ]}
          />
        </Card>

        <div className="grid gap-4 lg:grid-cols-3">
          {progress.awards.map((track) => (
            <AwardCard key={track.type} track={track} />
          ))}
        </div>

        <Card title="Milestones">
          <MilestonePath progress={progress} />
        </Card>

        {canSeeBreaks ? (
          <Card title="What ended a run" subtitle="Corrections update this automatically">
            {progress.breaks.length === 0 ? (
              <p className="text-sm font-medium text-muted">A clean record so far.</p>
            ) : (
              <ul className="divide-y divide-line/70">
                {progress.breaks.slice(0, BREAKS_SHOWN).map((row, index) => (
                  <li key={`${row.on}-${index}`} className="flex items-baseline justify-between gap-3 py-2.5 text-sm">
                    <span className="font-semibold text-ink">{row.reason === "late_balance" ? "Late balance" : row.ruleName}</span>
                    <span className="shrink-0 font-medium text-muted">{formatDate(row.on)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ) : null}
      </div>
    </>
  );
}
