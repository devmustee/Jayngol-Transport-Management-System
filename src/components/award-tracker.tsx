import Link from "next/link";
import {
  Award,
  Flag,
  Footprints,
  Lock,
  Medal,
  Route,
  ShieldCheck,
  Sparkles,
  Star,
  Trophy,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Badge, Card, Empty } from "@/components/ui";
import {
  closestFirst,
  MILESTONE_PATH,
  type AwardStage,
  type AwardTrack,
  type AwardType,
  type OperatorProgress,
} from "@/lib/award-progress";
import { AWARD_LABELS, formatDate } from "@/lib/format";

export const STAGE_LABELS: Record<AwardStage, string> = {
  ready: "Ready",
  close: "Close",
  on_the_way: "On the way",
  awaiting_decision: "Waiting for decision",
  under_review: "Under review",
  restarting: "Restarting",
  closed: "Closed",
  no_tricycle: "No tricycle",
};

const STAGE_TONES: Record<AwardStage, "gold" | "good" | "plain"> = {
  ready: "gold",
  close: "gold",
  on_the_way: "good",
  awaiting_decision: "gold",
  under_review: "plain",
  restarting: "plain",
  closed: "plain",
  no_tricycle: "plain",
};

export function StageBadge({ stage }: { stage: AwardStage }) {
  return (
    <Badge tone={STAGE_TONES[stage]} dot={stage === "ready"}>
      {STAGE_LABELS[stage]}
    </Badge>
  );
}

export function JourneyBar({ percent, label }: { percent: number; label: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-2 overflow-hidden rounded-full bg-line/60"
    >
      <div className="h-full origin-left animate-fill rounded-full bg-gradient-to-r from-gold to-gold-light" style={{ width: `${percent}%` }} />
    </div>
  );
}

const days = (count: number) => `${count} ${count === 1 ? "day" : "days"}`;

/** The award's one-line position, in the same words everywhere. */
export function trackHeadline(track: AwardTrack): string {
  if (track.stage === "closed") return track.closedReason ?? "Closed";
  if (track.stage === "no_tricycle") return "No tricycle at the moment";
  if (track.stage === "awaiting_decision") return "The Manager has this to decide";
  return `${days(track.daysToGo ?? 0)} to go`;
}

export const trackOf = (progress: OperatorProgress, type: AwardType) =>
  progress.awards.find((award) => award.type === type)!;

/** Worth acting on now: the next two award dates are within about 2 months. */
const NEAR_DAYS = 62;
export const isNear = (track: AwardTrack) =>
  track.daysToGo !== null && track.daysToGo <= NEAR_DAYS && track.stage !== "awaiting_decision";
export const isBehind = (track: AwardTrack) => track.coverage?.behind === true;

type RaceOperator = {
  operatorId: string;
  name: string;
  tricycleCode: string | null;
  progress: OperatorProgress;
};

export function RaceRow({ row, type }: { row: RaceOperator; type: AwardType }) {
  const track = trackOf(row.progress, type);
  const hasDate = track.nextAwardOn !== null;
  const starting = track.countingFrom !== null && track.journeyPercent === 0;
  return (
    <li>
      <Link
        href={`/awards/${row.operatorId}`}
        className="block rounded-xl px-2 py-3 transition-colors hover:bg-gold-wash/50"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-bold leading-snug text-ink">{row.name}</div>
            <div className="text-xs font-medium text-muted">
              {row.tricycleCode ?? "No tricycle"} · run {days(row.progress.currentRunDays)}
            </div>
          </div>
          <StageBadge stage={track.stage} />
        </div>
        {hasDate ? (
          <div className="mt-2.5">
            <JourneyBar percent={track.journeyPercent} label={`${row.name}: ${AWARD_LABELS[type]} journey`} />
          </div>
        ) : null}
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 text-xs font-semibold text-muted">
          <span>
            {trackHeadline(track)}
            {hasDate ? ` · ${formatDate(track.nextAwardOn!)}` : ""}
          </span>
          {isBehind(track) ? (
            <span className="text-warning">Inspections {track.coverage!.percent}%</span>
          ) : starting ? (
            <span>Counting starts {formatDate(track.countingFrom!)}</span>
          ) : null}
        </div>
      </Link>
    </li>
  );
}

export function RaceList({ rows, type }: { rows: RaceOperator[]; type: AwardType }) {
  return (
    <ul className="divide-y divide-line/70">
      {rows.map((row) => (
        <RaceRow key={row.operatorId} row={row} type={type} />
      ))}
    </ul>
  );
}

const seeAll = (href: string, label: string): ReactNode => (
  <Link href={href} className="inline-flex min-h-11 items-center text-sm font-bold text-gold-deep hover:underline">
    {label}
  </Link>
);

const HOME_ROWS = 3;
const URGENT_DAYS = 14;

/** The short version for the Home page. */
export function AwardRaceCard({ operators }: { operators: RaceOperator[] }) {
  const type: AwardType = "consistency";
  const running = closestFirst(operators, type).filter((row) => trackOf(row.progress, type).nextAwardOn !== null);
  const ready = running.filter((row) => trackOf(row.progress, type).stage === "ready").length;
  const urgent = running.filter((row) => {
    const track = trackOf(row.progress, type);
    return track.stage === "ready" && isBehind(track) && (track.daysToGo ?? 0) < URGENT_DAYS;
  }).length;
  return (
    <Card
      title="Award race"
      subtitle={`Closest to the ${AWARD_LABELS[type]} award · ${ready} ready`}
      action={seeAll("/awards", "See all")}
    >
      {urgent > 0 ? (
        <p className="mb-3 rounded-xl border border-warning-border bg-warning-wash px-3.5 py-2.5 text-sm font-semibold text-warning">
          {urgent} ready {urgent === 1 ? "operator is" : "operators are"} behind on inspections, with under {URGENT_DAYS} days left.
        </p>
      ) : null}
      {running.length === 0 ? (
        <Empty>No operator is working towards this award yet.</Empty>
      ) : (
        <RaceList rows={running.slice(0, HOME_ROWS)} type={type} />
      )}
    </Card>
  );
}

/** The short version for an operator's profile. */
export function AwardJourneyCard({ operatorId, progress }: { operatorId: string; progress: OperatorProgress }) {
  return (
    <Card title="Award journey" action={seeAll(`/awards/${operatorId}`, "View journey")}>
      <p className="mb-3 text-sm font-semibold text-ink">
        Current run {days(progress.currentRunDays)} · Best {days(progress.bestRunDays)}
      </p>
      <ul className="divide-y divide-line/70">
        {progress.awards.map((track) => (
          <li key={track.type} className="flex items-center justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <div className="text-sm font-bold text-ink">{AWARD_LABELS[track.type]}</div>
              <div className="text-xs font-medium text-muted">{trackHeadline(track)}</div>
            </div>
            <StageBadge stage={track.stage} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

const PATH_ICONS: Record<string, LucideIcon> = {
  first_week: Footprints,
  steady_rider: Star,
  one_month: Medal,
  two_months: ShieldCheck,
  halfway: Flag,
  road_veteran: Route,
  final_stretch: Sparkles,
  award_ready: Award,
};

export function MilestonePath({ progress }: { progress: OperatorProgress }) {
  const earned = new Map(progress.milestones.map((row) => [row.code, row]));
  const pathCodes = new Set(MILESTONE_PATH.map((step) => step.code));
  const extras = progress.milestones.filter((row) => !pathCodes.has(row.code));
  const next = progress.nextMilestone;
  return (
    <>
      <ol className="grid grid-cols-4 gap-x-2 gap-y-4 sm:grid-cols-8">
        {MILESTONE_PATH.map((step) => {
          const done = earned.get(step.code);
          const isNext = next?.code === step.code;
          const Icon = done ? PATH_ICONS[step.code]! : Lock;
          return (
            <li key={step.code} className="flex flex-col items-center text-center">
              <span
                className={`flex h-11 w-11 items-center justify-center rounded-full border ${
                  done ? "border-gold-light/60 bg-gold-wash text-gold-deep" : "border-line bg-card-subtle text-muted"
                } ${isNext ? "ring-2 ring-gold ring-offset-2 ring-offset-card" : ""}`}
              >
                <Icon size={18} aria-hidden />
              </span>
              <span className={`mt-1.5 text-[11px] font-semibold leading-tight ${done ? "text-ink" : "text-muted"}`}>
                {step.label}
              </span>
              <span className="sr-only">{done ? `Reached ${formatDate(done.reachedOn)}` : "Not reached yet"}</span>
            </li>
          );
        })}
      </ol>
      <p className="mt-4 text-sm font-semibold text-muted">
        {next ? `Next: ${next.label}, ${days(next.daysLeft)} left` : progress.currentRunDays > 0 ? "Every step on the path is complete." : "The path starts with the next clean run."}
      </p>
      {extras.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-2">
          {extras.map((row) => (
            <li
              key={row.code}
              className="inline-flex items-center gap-1.5 rounded-full border border-gold-light/60 bg-gold-wash px-3 py-1 text-xs font-bold text-gold-deep"
            >
              <Trophy size={13} aria-hidden />
              {row.label} · {formatDate(row.reachedOn)}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
