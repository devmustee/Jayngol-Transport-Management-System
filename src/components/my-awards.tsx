import { Check, Clock, Crown, Trophy, X } from "lucide-react";
import { JourneyBar, MilestonePath, StageBadge, trackHeadline, trackOf } from "@/components/award-tracker";
import { Card } from "@/components/ui";
import type { AwardTrack, BoardRow, OperatorProgress } from "@/lib/award-progress";
import { AWARD_LABELS, AWARD_PRIZES, formatDate } from "@/lib/format";
import { formatNaira } from "@/lib/money";

const days = (count: number) => `${count} ${count === 1 ? "day" : "days"}`;

const RING_RADIUS = 34;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

function ProgressRing({ percent }: { percent: number }) {
  return (
    <svg width="88" height="88" viewBox="0 0 88 88" role="img" aria-label={`${percent}% of the journey done`} className="shrink-0">
      <circle cx="44" cy="44" r={RING_RADIUS} fill="none" strokeWidth="8" className="stroke-paper/15" />
      <circle
        cx="44"
        cy="44"
        r={RING_RADIUS}
        fill="none"
        strokeWidth="8"
        strokeLinecap="round"
        strokeDasharray={`${(RING_LENGTH * percent) / 100} ${RING_LENGTH}`}
        strokeDashoffset={(RING_LENGTH * percent) / 100}
        transform="rotate(-90 44 44)"
        className="animate-draw stroke-gold-light"
      />
      <text x="44" y="50" textAnchor="middle" className="fill-paper text-lg font-extrabold">
        {percent}%
      </text>
    </svg>
  );
}

/** One plain sentence for where the operator stands today. */
function heroMessage(track: AwardTrack, progress: OperatorProgress): string | null {
  if (track.stage === "restarting" && progress.lastBreak) {
    const why = progress.lastBreak.reason === "late_balance" ? "a late balance" : "an offence";
    return `Your run ended on ${formatDate(progress.lastBreak.on)} because of ${why}. Your best to beat: ${days(progress.bestRunDays)}.`;
  }
  if (track.stage === "under_review") return "An offence is being reviewed. If it is confirmed, your award date may move.";
  if (track.stage === "awaiting_decision") return "You qualified. The Manager is deciding your award now.";
  if (track.stage === "ready") return "Keep it clean until the award date and this is yours.";
  if (track.stage === "close") return "You are close. Stay clean and this award is within reach.";
  return null;
}

function JourneyHero({ progress }: { progress: OperatorProgress }) {
  const track = trackOf(progress, "consistency");
  const message = heroMessage(track, progress);
  const hasDate = track.nextAwardOn !== null;
  return (
    <section className="rounded-2xl bg-ink p-5 text-paper">
      <div className="flex items-center gap-2 text-sm font-bold text-gold-light">
        <Trophy size={16} aria-hidden />
        <span>
          {AWARD_LABELS.consistency} award · {AWARD_PRIZES.consistency}
        </span>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-3xl font-extrabold leading-tight tracking-tight">{trackHeadline(track)}</p>
          {hasDate ? (
            <p className="mt-1 text-sm font-medium text-paper/70">
              Award date {formatDate(track.nextAwardOn!)}
            </p>
          ) : null}
        </div>
        {hasDate ? <ProgressRing percent={track.journeyPercent} /> : null}
      </div>
      {message ? <p className="mt-3 text-sm font-semibold text-gold-light">{message}</p> : null}
      {hasDate && track.journeyPercent === 0 ? (
        <p className="mt-1 text-xs font-medium text-paper/70">Your 6 months start counting on {formatDate(track.countingFrom!)}.</p>
      ) : null}
    </section>
  );
}

const weekday = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "narrow", timeZone: "UTC" });

const DAY_STYLES = {
  clean: "border-gold-light/60 bg-gold-wash text-gold-deep",
  missed: "border-danger-border bg-danger-wash text-danger",
  none: "border-line bg-card-subtle text-muted",
};
const DAY_WORDS = { clean: "clean", missed: "run ended", none: "not working yet" };

function RunCounter({ progress }: { progress: OperatorProgress }) {
  return (
    <Card>
      <div className="flex justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-muted">Current run</p>
          <p className="text-2xl font-extrabold tracking-tight text-ink">{days(progress.currentRunDays)}</p>
        </div>
        <div className="text-right">
          <p className="text-sm font-semibold text-muted">Your best</p>
          <p className="text-2xl font-extrabold tracking-tight text-ink">{days(progress.bestRunDays)}</p>
        </div>
      </div>
      <ol className="mt-4 grid grid-cols-7 gap-1.5" aria-label="Your last 7 days">
        {progress.recentDays.map((day) => (
          <li key={day.on} className="flex flex-col items-center gap-1">
            <span className={`flex h-9 w-9 items-center justify-center rounded-full border ${DAY_STYLES[day.status]}`}>
              {day.status === "clean" ? <Check size={16} aria-hidden /> : day.status === "missed" ? <X size={16} aria-hidden /> : null}
            </span>
            <span className="text-xs font-semibold text-muted" aria-hidden>
              {weekday(day.on)}
            </span>
            <span className="sr-only">
              {formatDate(day.on)}: {DAY_WORDS[day.status]}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function AwardRow({ track }: { track: AwardTrack }) {
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-bold text-ink">{AWARD_LABELS[track.type]}</div>
          <div className="text-xs font-medium text-muted">Prize: {AWARD_PRIZES[track.type]}</div>
        </div>
        <StageBadge stage={track.stage} />
      </div>
      <p className="mt-1.5 text-sm font-semibold text-ink">{trackHeadline(track)}</p>
      {track.nextAwardOn ? (
        <div className="mt-1.5">
          <JourneyBar percent={track.journeyPercent} label={`${AWARD_LABELS[track.type]} journey`} />
        </div>
      ) : null}
      {track.coverage?.behind ? (
        <p className="mt-1.5 text-xs font-semibold text-warning">We need to inspect your tricycle more often. Ask your Supervisor.</p>
      ) : null}
    </li>
  );
}

function HonourBoard({ rows, daysToBoard }: { rows: BoardRow[]; daysToBoard: number | null }) {
  return (
    <Card title="Honour board" subtitle="The longest clean runs right now">
      {rows.length === 0 ? (
        <p className="text-sm font-medium text-muted">The first clean runs will appear here.</p>
      ) : (
        <ol className="divide-y divide-line/60">
          {rows.map((row, index) => (
            <li key={`${row.name}-${index}`} className={`flex items-center gap-3 py-2.5 ${row.isYou ? "rounded-xl bg-gold-wash/60 px-2" : ""}`}>
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gold-wash text-sm font-extrabold text-gold-deep">
                {index === 0 ? <Crown size={16} aria-label="First" /> : index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm leading-snug font-bold text-ink">
                  {row.name}
                  {row.isYou ? " (you)" : ""}
                </div>
                <div className="text-xs leading-snug font-medium text-muted">{[row.tricycleCode, ...row.badges].filter(Boolean).join(" · ")}</div>
              </div>
              <span className="shrink-0 text-sm font-extrabold tabular-nums text-ink">{days(row.runDays)}</span>
            </li>
          ))}
        </ol>
      )}
      {daysToBoard !== null ? (
        <p className="mt-3 text-sm font-semibold text-gold-deep">Stay clean {days(daysToBoard)} longer than the 5th place run to join the board.</p>
      ) : null}
    </Card>
  );
}

export function MyAwardJourney({
  progress,
  board,
  runAtRisk,
}: {
  progress: OperatorProgress;
  board: { rows: BoardRow[]; daysToBoard: number | null };
  runAtRisk: { owedKobo: number } | null;
}) {
  return (
    <>
      <JourneyHero progress={progress} />
      {runAtRisk && progress.currentRunDays > 0 ? (
        <section className="rounded-2xl border border-warning-border bg-warning-wash p-4 text-warning">
          <p className="flex items-center gap-2 text-sm font-extrabold">
            <Clock size={16} aria-hidden />
            Protect your run
          </p>
          <p className="mt-1 text-sm font-semibold">
            Pay {formatNaira(runAtRisk.owedKobo)} by midnight to keep your {progress.currentRunDays}-day run.
          </p>
        </section>
      ) : null}
      <RunCounter progress={progress} />
      <Card title="Milestones">
        <MilestonePath progress={progress} />
      </Card>
      <Card title="Your awards">
        <ul className="divide-y divide-line/60">
          {progress.awards.map((track) => (
            <AwardRow key={track.type} track={track} />
          ))}
        </ul>
        {progress.cleanSix && progress.awards.some((track) => track.stage === "closed") ? (
          <p className="mt-3 rounded-xl border border-gold-light/60 bg-gold-wash px-3.5 py-2.5 text-sm font-semibold text-gold-deep">
            You can still earn the Clean Six badge: {days(progress.cleanSix.daysLeft)} with no offence.
          </p>
        ) : null}
      </Card>
      <HonourBoard rows={board.rows} daysToBoard={board.daysToBoard} />
    </>
  );
}
