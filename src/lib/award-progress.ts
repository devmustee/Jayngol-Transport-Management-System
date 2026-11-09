import { addDays, addMonths, daysBetween } from "@/lib/clock";
import { AWARD_LABELS } from "@/lib/format";

/**
 * The calculations behind the award tracker (AWARD_TRACKER_PLAN.md). Everything
 * here is worked out from an operator's records, so a waived offence or a
 * reversed payment changes the result by itself and nobody can edit a streak.
 */

export type AwardType = keyof typeof AWARD_LABELS;
export const AWARD_TYPES = Object.keys(AWARD_LABELS) as AwardType[];

export const SERVICE_MONTHS = 6;
export const MIN_COVERAGE_PERCENT = 80;
const RESTARTING_DAYS = 30;
const COMEBACK_DAYS = 30;
/** Past this many monthly award dates, every past record has left the window. */
const MAX_AWARD_DATES = 9;

export type Stint = { issuedOn: string; returnedOn: string | null; returnReason: string | null };

export type OperatorHistory = {
  status: string;
  stints: Stint[];
  /** The charge date of each balance not fully paid by its deadline. */
  lateBalances: string[];
  confirmedOffences: { on: string; ruleCode: string; ruleName?: string | null }[];
  undecidedOffences: { on: string; ruleCode: string }[];
  /** Every award decision, in any state: each one covers its 6 months. */
  decisions: { type: AwardType; periodTo: string; status: string; givenOn: string | null }[];
  /** Recent working days, and whether the tricycle was inspected on each. */
  workingDays: { on: string; inspected: boolean }[];
};

export type AwardStage =
  | "ready"
  | "close"
  | "on_the_way"
  | "under_review"
  | "restarting"
  | "awaiting_decision"
  | "closed"
  | "no_tricycle";

export type AwardTrack = {
  type: AwardType;
  stage: AwardStage;
  closedReason: string | null;
  nextAwardOn: string | null;
  daysToGo: number | null;
  /** The first day of the 6 months being judged. It can still be in the future. */
  countingFrom: string | null;
  journeyPercent: number;
  underReview: number;
  coverage: { workingDays: number; inspectedDays: number; percent: number; behind: boolean } | null;
};

export type Milestone = { code: string; label: string; reachedOn: string };

export type OperatorProgress = {
  currentRunDays: number;
  runStartedOn: string | null;
  bestRunDays: number;
  lastBreak: { on: string; reason: "late_balance" | "offence" } | null;
  /** Newest first. */
  breaks: { on: string; reason: "late_balance" | "offence"; ruleName: string | null }[];
  milestones: Milestone[];
  nextMilestone: { code: string; label: string; reachedOn: string; daysLeft: number } | null;
  /** For someone shut out of a "never" award: the next badge they can still reach. */
  cleanSix: { reachedOn: string; daysLeft: number } | null;
  /** The last 7 finished days, oldest first. Today is not judged until it ends. */
  recentDays: { on: string; status: "clean" | "missed" | "none" }[];
  awards: AwardTrack[];
};

/** Only leaving or being sacked ends service. Changing tricycle does not. */
const ENDS_SERVICE = new Set(["operator_left", "sacked"]);

type ServicePeriod = { start: string; end: string | null };

function servicePeriods(stints: Stint[]): ServicePeriod[] {
  const periods: ServicePeriod[] = [];
  let ended = true;
  for (const stint of [...stints].sort((a, b) => a.issuedOn.localeCompare(b.issuedOn))) {
    if (ended) periods.push({ start: stint.issuedOn, end: stint.returnedOn });
    else periods[periods.length - 1]!.end = stint.returnedOn;
    ended = ENDS_SERVICE.has(stint.returnReason ?? "");
  }
  return periods;
}

/** When the operator's latest unbroken service began. */
export function serviceStart(stints: Stint[]): string | null {
  return servicePeriods(stints).at(-1)?.start ?? null;
}

type Run = { from: string; until: string; afterBreak: boolean; current: boolean };
const runDays = (run: Run) => Math.max(0, daysBetween(run.from, run.until));

/** Clean runs, oldest first. `until` is the first day that does not count. */
function runsBetween(periods: ServicePeriod[], breaks: string[], today: string, onTricycle: boolean): Run[] {
  const dates = [...new Set(breaks)].filter((date) => date <= today).sort();
  const runs: Run[] = [];
  periods.forEach((period, index) => {
    const finish = period.end && period.end < today ? period.end : today;
    let from = period.start;
    let afterBreak = false;
    for (const date of dates) {
      if (date < from || date > finish) continue;
      runs.push({ from, until: date, afterBreak, current: false });
      from = addDays(date, 1);
      afterBreak = true;
    }
    runs.push({ from, until: finish, afterBreak, current: onTricycle && index === periods.length - 1 });
  });
  return runs;
}

type PathStep = { code: string; label: string; days?: number; months?: number };

export const MILESTONE_PATH: PathStep[] = [
  { code: "first_week", label: "First Week", days: 7 },
  { code: "steady_rider", label: "Steady Rider", days: 14 },
  { code: "one_month", label: "One Month Strong", months: 1 },
  { code: "two_months", label: "Two Month Trust", months: 2 },
  { code: "halfway", label: "Halfway Hero", months: 3 },
  { code: "road_veteran", label: "Road Veteran", months: 4 },
  { code: "final_stretch", label: "Final Stretch", months: 5 },
  { code: "award_ready", label: "Award Ready", months: 6 },
];

const reachedOn = (from: string, step: PathStep) =>
  step.days ? addDays(from, step.days) : addMonths(from, step.months!);

function earnedMilestones(history: OperatorHistory, runs: Run[], offenceRuns: Run[]): Milestone[] {
  const earned = new Map<string, Milestone>();
  const earn = (code: string, label: string, on: string) => {
    const known = earned.get(code);
    if (!known || on < known.reachedOn) earned.set(code, { code, label, reachedOn: on });
  };

  let best = 0;
  for (const run of runs) {
    for (const step of MILESTONE_PATH) {
      const on = reachedOn(run.from, step);
      if (on <= run.until) earn(step.code, step.label, on);
    }
    const comeback = addDays(run.from, COMEBACK_DAYS);
    if (run.afterBreak && comeback <= run.until) earn("comeback", "Comeback", comeback);
    if (best >= NOTABLE_RUN_DAYS && runDays(run) > best) earn("new_best", "New Best", addDays(run.from, best + 1));
    best = Math.max(best, runDays(run));
  }

  const offences = history.confirmedOffences.map((row) => row.on);
  for (const run of offenceRuns) {
    const on = addMonths(run.from, SERVICE_MONTHS);
    if (on <= run.until && offences.some((date) => date < run.from)) earn("clean_six", "Clean Six", on);
  }

  for (const win of history.decisions) {
    if (win.status === "approved" && win.givenOn) {
      earn(`winner_${win.type}_${win.givenOn}`, `${AWARD_LABELS[win.type]} Winner`, win.givenOn);
    }
  }
  return [...earned.values()].sort((a, b) => a.reachedOn.localeCompare(b.reachedOn));
}

export const firstOfNextMonth = (today: string) => addMonths(`${today.slice(0, 8)}01`, 1);

/** The first award date this operator would pass if nothing else goes wrong. */
function projectAwardDate(history: OperatorHistory, type: AwardType, breaks: string[], today: string) {
  const start = serviceStart(history.stints);
  if (!start) return null;
  const considered = type === "consistency" ? breaks : [];
  const decided = history.decisions
    .filter((row) => row.type === type)
    .map((row) => row.periodTo)
    .sort()
    .at(-1);
  let run = firstOfNextMonth(today);
  for (let awardDatesAway = 1; awardDatesAway <= MAX_AWARD_DATES; awardDatesAway++) {
    const from = addMonths(run, -SERVICE_MONTHS);
    if (start <= from && considered.every((date) => date < from) && (!decided || decided < from)) {
      return { run, from, awardDatesAway };
    }
    run = addMonths(run, 1);
  }
  return null;
}

function closedReason(history: OperatorHistory, type: AwardType): string | null {
  if (history.status !== "active") return "Only active operators can win awards.";
  if (type === "clean_vehicle" && history.confirmedOffences.some((row) => row.ruleCode === "R2")) {
    return "A washing offence is on record.";
  }
  if (type === "law_abiding" && history.confirmedOffences.length > 0) return "An offence is on record.";
  return null;
}

function coverageSince(history: OperatorHistory, from: string, today: string) {
  const days = history.workingDays.filter((day) => day.on >= from && day.on <= today);
  const inspectedDays = days.filter((day) => day.inspected).length;
  return {
    workingDays: days.length,
    inspectedDays,
    percent: days.length === 0 ? 0 : Math.floor((inspectedDays * 100) / days.length),
    // Whole numbers, so exactly 80% passes, as it does for the real award.
    behind: inspectedDays * 100 < days.length * MIN_COVERAGE_PERCENT,
  };
}

function underReviewCount(history: OperatorHistory, type: AwardType, from: string | null) {
  return history.undecidedOffences.filter((row) => {
    if (type === "consistency") return from !== null && row.on >= from;
    return type === "law_abiding" || row.ruleCode === "R2";
  }).length;
}

function trackAward(history: OperatorHistory, type: AwardType, breaks: string[], today: string): AwardTrack {
  const onTricycle = history.stints.some((stint) => stint.returnedOn === null);
  const reason = closedReason(history, type);
  const projected = reason ? null : projectAwardDate(history, type, breaks, today);
  const from = projected?.from ?? null;
  const underReview = underReviewCount(history, type, from);
  const lastBreak = [...breaks].filter((date) => date <= today).sort().at(-1);

  let stage: AwardStage;
  if (reason) stage = "closed";
  else if (!onTricycle || !projected) stage = "no_tricycle";
  else if (history.decisions.some((row) => row.type === type && row.status === "proposed")) stage = "awaiting_decision";
  else if (underReview > 0) stage = "under_review";
  else if (type === "consistency" && lastBreak && daysBetween(lastBreak, today) <= RESTARTING_DAYS) stage = "restarting";
  else if (projected.awardDatesAway === 1) stage = "ready";
  else if (projected.awardDatesAway === 2) stage = "close";
  else stage = "on_the_way";

  const showDate = projected && stage !== "closed" && stage !== "no_tricycle";
  const total = projected ? daysBetween(projected.from, projected.run) : 0;
  const elapsed = projected ? daysBetween(projected.from, today) : 0;
  return {
    type,
    stage,
    closedReason: reason,
    nextAwardOn: showDate ? projected.run : null,
    daysToGo: showDate ? daysBetween(today, projected.run) : null,
    countingFrom: showDate ? projected.from : null,
    journeyPercent: showDate ? Math.min(100, Math.max(0, Math.floor((elapsed * 100) / total))) : 0,
    underReview,
    coverage: showDate ? coverageSince(history, projected.from, today) : null,
  };
}

/** An automatic late-balance fine (R1) is still a late balance to the operator. */
function breakReason(history: OperatorHistory, on: string): "late_balance" | "offence" {
  const conduct = history.confirmedOffences.some((row) => row.on === on && row.ruleCode !== "R1");
  return conduct ? "offence" : "late_balance";
}

const RECENT_DAYS = 7;

function recentDays(periods: ServicePeriod[], breaks: string[], today: string): OperatorProgress["recentDays"] {
  return Array.from({ length: RECENT_DAYS }, (_, index) => {
    const on = addDays(today, index - RECENT_DAYS);
    const served = periods.some((period) => period.start <= on && (!period.end || on <= period.end));
    return { on, status: !served ? "none" : breaks.includes(on) ? "missed" : "clean" };
  });
}

function cleanSixCountdown(offences: string[], current: Run | undefined, earned: Milestone[], today: string) {
  if (!current || earned.some((row) => row.code === "clean_six")) return null;
  if (!offences.some((date) => date < current.from)) return null;
  const reachedOn = addMonths(current.from, SERVICE_MONTHS);
  return reachedOn > today ? { reachedOn, daysLeft: daysBetween(today, reachedOn) } : null;
}

export function operatorProgress(history: OperatorHistory, today: string): OperatorProgress {
  const periods = servicePeriods(history.stints);
  const onTricycle = history.stints.some((stint) => stint.returnedOn === null);
  const offences = history.confirmedOffences.map((row) => row.on);
  const breaks = [...history.lateBalances, ...offences];

  const runs = runsBetween(periods, breaks, today, onTricycle);
  const current = runs.find((run) => run.current);
  const nextStep = current && MILESTONE_PATH.find((step) => reachedOn(current.from, step) > today);
  const lastOn = breaks.filter((date) => date <= today).sort().at(-1);
  const offenceRuns = runsBetween(periods, offences, today, onTricycle);
  const milestones = earnedMilestones(history, runs, offenceRuns);

  return {
    currentRunDays: current ? runDays(current) : 0,
    runStartedOn: current?.from ?? null,
    bestRunDays: Math.max(0, ...runs.map(runDays)),
    lastBreak: lastOn ? { on: lastOn, reason: breakReason(history, lastOn) } : null,
    breaks: [
      ...[...new Set(history.lateBalances)].map((on) => ({ on, reason: "late_balance" as const, ruleName: null })),
      ...history.confirmedOffences.map((row) => ({
        on: row.on,
        reason: "offence" as const,
        ruleName: row.ruleName ?? row.ruleCode,
      })),
    ]
      .filter((row) => row.on <= today)
      .sort((a, b) => b.on.localeCompare(a.on)),
    milestones,
    cleanSix: cleanSixCountdown(offences, offenceRuns.find((run) => run.current), milestones, today),
    recentDays: recentDays(periods, breaks, today),
    nextMilestone:
      current && nextStep
        ? {
            code: nextStep.code,
            label: nextStep.label,
            reachedOn: reachedOn(current.from, nextStep),
            daysLeft: daysBetween(today, reachedOn(current.from, nextStep)),
          }
        : null,
    awards: AWARD_TYPES.map((type) => trackAward(history, type, breaks, today)),
  };
}

/** Closest to winning first. Those with no date to aim for go last. */
export function closestFirst<T extends { name: string; progress: OperatorProgress }>(rows: T[], type: AwardType): T[] {
  const track = (row: T) => row.progress.awards.find((award) => award.type === type)!;
  return [...rows].sort(
    (a, b) =>
      (track(a).nextAwardOn ?? "9999").localeCompare(track(b).nextAwardOn ?? "9999") ||
      b.progress.currentRunDays - a.progress.currentRunDays ||
      a.name.localeCompare(b.name),
  );
}

/** A run this short ending is not worth a message of its own. */
export const NOTABLE_RUN_DAYS = 7;
const RUN_ENDED_WINDOW_DAYS = 3;

/**
 * The notable run that has just ended, if any. A late balance is only known two
 * days after its charge date, so this looks back a few days rather than at today.
 */
export function justEndedRun(history: OperatorHistory, today: string) {
  const breaks = [...history.lateBalances, ...history.confirmedOffences.map((row) => row.on)];
  const onTricycle = history.stints.some((stint) => stint.returnedOn === null);
  const ended = runsBetween(servicePeriods(history.stints), breaks, today, onTricycle)
    .filter((run) => !run.current && run.until < today)
    .filter((run) => runDays(run) >= NOTABLE_RUN_DAYS && daysBetween(run.until, today) <= RUN_ENDED_WINDOW_DAYS)
    .at(-1);
  return ended ? { endedOn: ended.until, days: runDays(ended) } : null;
}

const BOARD_SIZE = 5;

export type BoardRow = { name: string; tricycleCode: string | null; runDays: number; badges: string[]; isYou: boolean };

/**
 * The top 5 current runs. It holds only what is safe for every operator to see,
 * so nobody is shown as last and no debt or offence appears.
 */
export function honourBoard<T extends { operatorId: string; name: string; tricycleCode: string | null; progress: OperatorProgress }>(
  rows: T[],
  myOperatorId: string,
) {
  const running = rows
    .filter((row) => row.progress.currentRunDays > 0)
    .sort((a, b) => b.progress.currentRunDays - a.progress.currentRunDays || a.name.localeCompare(b.name));
  const top = running.slice(0, BOARD_SIZE);
  const mine = rows.find((row) => row.operatorId === myOperatorId);
  const onBoard = top.some((row) => row.operatorId === myOperatorId);
  const last = top.at(-1);
  return {
    rows: top.map((row): BoardRow => {
      const earned = new Set(row.progress.milestones.map((item) => item.code));
      const highest = MILESTONE_PATH.filter((step) => earned.has(step.code)).at(-1);
      const wins = row.progress.milestones.filter((item) => item.code.startsWith("winner_")).map((item) => item.label);
      return {
        name: row.name,
        tricycleCode: row.tricycleCode,
        runDays: row.progress.currentRunDays,
        badges: [...(highest ? [highest.label] : []), ...new Set(wins)],
        isYou: row.operatorId === myOperatorId,
      };
    }),
    daysToBoard:
      onBoard || !mine || !last || top.length < BOARD_SIZE ? null : last.progress.currentRunDays - mine.progress.currentRunDays + 1,
  };
}
