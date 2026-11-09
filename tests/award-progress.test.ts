import { describe, expect, it } from "vitest";
import {
  closestFirst,
  honourBoard,
  justEndedRun,
  operatorProgress,
  serviceStart,
  type AwardType,
  type OperatorHistory,
  type Stint,
} from "@/lib/award-progress";
import { daysBetween } from "@/lib/clock";

const ISSUED = "2026-10-08";
const TODAY = "2026-11-09";
const open = (issuedOn = ISSUED): Stint => ({ issuedOn, returnedOn: null, returnReason: null });
const closed = (issuedOn: string, returnedOn: string, returnReason: string): Stint => ({ issuedOn, returnedOn, returnReason });

const history = (extra: Partial<OperatorHistory> = {}): OperatorHistory => ({
  status: "active",
  stints: [open()],
  lateBalances: [],
  confirmedOffences: [],
  undecidedOffences: [],
  decisions: [],
  workingDays: [],
  ...extra,
});
const award = (h: OperatorHistory, today: string, type: AwardType = "consistency") =>
  operatorProgress(h, today).awards.find((row) => row.type === type)!;
const codes = (h: OperatorHistory, today: string) => operatorProgress(h, today).milestones.map((row) => row.code);

describe("daysBetween", () => {
  it("counts whole days across months and backwards", () => {
    expect(daysBetween("2026-11-09", "2027-05-01")).toBe(173);
    expect(daysBetween("2026-11-09", "2026-11-09")).toBe(0);
    expect(daysBetween("2026-11-09", "2026-11-08")).toBe(-1);
  });
});

describe("service", () => {
  it("is not broken by changing tricycle", () => {
    expect(serviceStart([closed("2026-01-05", "2026-03-01", "reassigned"), open("2026-03-01")])).toBe("2026-01-05");
    expect(serviceStart([closed("2026-01-05", "2026-03-01", "tricycle_retired"), open("2026-03-02")])).toBe("2026-01-05");
  });

  it("restarts when the operator left or was sacked", () => {
    expect(serviceStart([closed("2026-01-05", "2026-03-01", "operator_left"), open("2026-06-01")])).toBe("2026-06-01");
    expect(serviceStart([closed("2026-01-05", "2026-03-01", "sacked"), open("2026-06-01")])).toBe("2026-06-01");
  });

  it("does not depend on the order records arrive in", () => {
    expect(serviceStart([open("2026-06-01"), closed("2026-01-05", "2026-03-01", "operator_left")])).toBe("2026-06-01");
  });

  it("is empty for an operator never issued a tricycle", () => {
    expect(serviceStart([])).toBeNull();
  });
});

describe("the sample operator: issued 8 Oct 2026, seen on 9 Nov 2026", () => {
  const progress = operatorProgress(history(), TODAY);

  it("counts down to 1 May 2027", () => {
    expect(award(history(), TODAY)).toMatchObject({
      stage: "on_the_way",
      nextAwardOn: "2027-05-01",
      daysToGo: 173,
      countingFrom: "2026-11-01",
      journeyPercent: 4, // 8 of 181 days
    });
  });

  it("knows the run, the milestones and the next one", () => {
    expect(progress).toMatchObject({ currentRunDays: 32, bestRunDays: 32, runStartedOn: ISSUED, lastBreak: null });
    expect(progress.milestones).toEqual([
      { code: "first_week", label: "First Week", reachedOn: "2026-10-15" },
      { code: "steady_rider", label: "Steady Rider", reachedOn: "2026-10-22" },
      { code: "one_month", label: "One Month Strong", reachedOn: "2026-11-08" },
    ]);
    expect(progress.nextMilestone).toMatchObject({ code: "two_months", reachedOn: "2026-12-08", daysLeft: 29 });
  });
});

describe("what a break costs", () => {
  it("moves the date by one month for a late balance on 5 Nov", () => {
    const h = history({ lateBalances: ["2026-11-05"] });
    expect(award(h, TODAY)).toMatchObject({
      stage: "restarting",
      nextAwardOn: "2027-06-01",
      countingFrom: "2026-12-01",
      journeyPercent: 0,
    });
    expect(operatorProgress(h, TODAY)).toMatchObject({
      currentRunDays: 3,
      runStartedOn: "2026-11-06",
      bestRunDays: 28,
      lastBreak: { on: "2026-11-05", reason: "late_balance" },
    });
  });

  it("costs nothing when the break is before the 6 months being judged", () => {
    expect(award(history({ lateBalances: ["2026-10-20"] }), TODAY).nextAwardOn).toBe("2027-05-01");
  });

  it("handles a break on the last day and the first day of a month", () => {
    expect(award(history({ lateBalances: ["2027-01-31"] }), "2027-02-05").nextAwardOn).toBe("2027-08-01");
    expect(award(history({ lateBalances: ["2027-02-01"] }), "2027-02-05").nextAwardOn).toBe("2027-09-01");
  });

  it("names an offence as the reason", () => {
    const h = history({ confirmedOffences: [{ on: "2026-11-05", ruleCode: "R3" }] });
    expect(operatorProgress(h, TODAY).lastBreak).toEqual({ on: "2026-11-05", reason: "offence" });
  });

  it("calls an automatic late fine a late balance, not an offence", () => {
    const h = history({ confirmedOffences: [{ on: "2026-11-05", ruleCode: "R1" }] });
    expect(operatorProgress(h, TODAY).lastBreak).toEqual({ on: "2026-11-05", reason: "late_balance" });
  });

  it("stops saying restarting after 30 days", () => {
    const h = history({ lateBalances: ["2026-11-05"] });
    expect(award(h, "2026-12-05").stage).toBe("restarting");
    expect(award(h, "2026-12-06").stage).toBe("on_the_way");
  });

  it("does not let a late balance touch the two conduct awards", () => {
    const h = history({ lateBalances: ["2026-11-05"] });
    expect(award(h, TODAY, "clean_vehicle")).toMatchObject({ stage: "on_the_way", nextAwardOn: "2027-05-01" });
    expect(award(h, TODAY, "law_abiding")).toMatchObject({ stage: "on_the_way", nextAwardOn: "2027-05-01" });
  });

  it("is not affected by days with no charge, such as off-road periods", () => {
    const h = history({ workingDays: [{ on: "2026-11-02", inspected: true }] });
    expect(operatorProgress(h, TODAY).currentRunDays).toBe(32);
  });
});

describe("stages", () => {
  it("is Ready for the coming award date and Close for the one after", () => {
    expect(award(history(), "2027-04-10")).toMatchObject({ stage: "ready", nextAwardOn: "2027-05-01", daysToGo: 21 });
    expect(award(history(), "2027-03-10")).toMatchObject({ stage: "close", nextAwardOn: "2027-05-01", daysToGo: 52 });
    expect(award(history(), "2027-02-10")).toMatchObject({ stage: "on_the_way", nextAwardOn: "2027-05-01" });
  });

  it("looks to the next month on the 1st itself", () => {
    expect(award(history(), "2027-05-01").nextAwardOn).toBe("2027-06-01");
  });

  it("shows a proposed offence as under review, keeping the date", () => {
    const h = history({ undecidedOffences: [{ on: "2026-11-05", ruleCode: "R3" }] });
    expect(award(h, TODAY)).toMatchObject({ stage: "under_review", underReview: 1, nextAwardOn: "2027-05-01" });
    expect(operatorProgress(h, TODAY).currentRunDays).toBe(32);
  });

  it("only counts a proposed washing offence against clean vehicle", () => {
    const h = history({ undecidedOffences: [{ on: "2026-11-05", ruleCode: "R3" }] });
    expect(award(h, TODAY, "clean_vehicle")).toMatchObject({ stage: "on_the_way", underReview: 0 });
    expect(award(h, TODAY, "law_abiding")).toMatchObject({ stage: "under_review", underReview: 1 });
  });

  it("closes clean vehicle only for a washing offence", () => {
    const other = history({ confirmedOffences: [{ on: "2026-10-20", ruleCode: "R3" }] });
    expect(award(other, TODAY, "clean_vehicle").stage).toBe("on_the_way");
    expect(award(other, TODAY, "law_abiding")).toMatchObject({ stage: "closed", nextAwardOn: null, daysToGo: null });

    const washing = history({ confirmedOffences: [{ on: "2026-10-20", ruleCode: "R2" }] });
    expect(award(washing, TODAY, "clean_vehicle")).toMatchObject({ stage: "closed", closedReason: "A washing offence is on record." });
    expect(award(washing, TODAY).nextAwardOn).toBe("2027-05-01");
  });

  it("closes every award for an operator who is not active", () => {
    expect(award(history({ status: "sacked" }), TODAY).stage).toBe("closed");
  });

  it("gives no date to an operator with no tricycle", () => {
    const h = history({ stints: [closed(ISSUED, "2026-11-01", "reassigned")] });
    expect(award(h, TODAY)).toMatchObject({ stage: "no_tricycle", nextAwardOn: null });
    expect(operatorProgress(h, TODAY)).toMatchObject({ currentRunDays: 0, runStartedOn: null, bestRunDays: 24, nextMilestone: null });
  });
});

describe("inspection coverage", () => {
  const days = (inspected: number, total: number) =>
    Array.from({ length: total }, (_, i) => ({ on: `2026-11-0${i + 1}`, inspected: i < inspected }));

  it("passes at exactly 80% and warns below, without changing the stage", () => {
    expect(award(history({ workingDays: days(4, 5) }), TODAY).coverage).toEqual({ workingDays: 5, inspectedDays: 4, percent: 80, behind: false });
    const behind = award(history({ workingDays: days(3, 4) }), TODAY);
    expect(behind.coverage).toMatchObject({ percent: 75, behind: true });
    expect(behind.stage).toBe("on_the_way");
  });

  it("ignores working days before the 6 months being judged", () => {
    const h = history({ workingDays: [{ on: "2026-10-20", inspected: false }, { on: "2026-11-02", inspected: true }] });
    expect(award(h, TODAY).coverage).toMatchObject({ workingDays: 1, behind: false });
  });
});

describe("decisions already made", () => {
  const decided = (status: string, givenOn: string | null = null) =>
    history({
      stints: [open("2026-01-05")],
      decisions: [{ type: "consistency", periodTo: "2026-12-31", status, givenOn }],
    });

  it("starts the next period after a win", () => {
    expect(award(decided("approved", "2027-01-03"), "2027-01-10")).toMatchObject({ stage: "on_the_way", nextAwardOn: "2027-07-01" });
  });

  it("treats a rejected period as used, as the award engine does", () => {
    expect(award(decided("rejected"), "2027-01-10").nextAwardOn).toBe("2027-07-01");
  });

  it("shows when a decision is waiting", () => {
    expect(award(decided("proposed"), "2027-01-10").stage).toBe("awaiting_decision");
  });

  it("leaves other award types alone", () => {
    expect(award(decided("approved", "2027-01-03"), "2027-01-10", "law_abiding").nextAwardOn).toBe("2027-02-01");
  });

  it("awards a winner badge with its date", () => {
    expect(operatorProgress(decided("approved", "2027-01-03"), "2027-01-10").milestones).toContainEqual({
      code: "winner_consistency_2027-01-03",
      label: "Consistency Winner",
      reachedOn: "2027-01-03",
    });
  });
});

describe("milestones", () => {
  it("is reached on the exact day and not before", () => {
    expect(codes(history(), "2026-10-14")).not.toContain("first_week");
    expect(codes(history(), "2026-10-15")).toContain("first_week");
  });

  it("completes the path at 6 months and then has no next step", () => {
    const progress = operatorProgress(history(), "2027-04-08");
    expect(progress.milestones.map((row) => row.code)).toContain("award_ready");
    expect(progress.nextMilestone).toBeNull();
  });

  it("keeps milestones earned before a break", () => {
    const h = history({ lateBalances: ["2026-11-20"] });
    expect(codes(h, "2026-11-22")).toEqual(["first_week", "steady_rider", "one_month"]);
    expect(operatorProgress(h, "2026-11-22").nextMilestone).toMatchObject({ code: "first_week", reachedOn: "2026-11-28" });
  });

  it("gives Comeback at 30 clean days after a break only", () => {
    expect(codes(history(), "2026-12-30")).not.toContain("comeback");
    const h = history({ lateBalances: ["2026-11-05"] });
    expect(codes(h, "2026-12-05")).not.toContain("comeback");
    expect(codes(h, "2026-12-06")).toContain("comeback");
  });

  it("gives New Best one day after passing the old best", () => {
    const h = history({ lateBalances: ["2026-10-18"] }); // an earlier run of 10 days
    expect(codes(h, "2026-10-29")).not.toContain("new_best");
    expect(operatorProgress(h, "2026-10-30").milestones).toContainEqual({ code: "new_best", label: "New Best", reachedOn: "2026-10-30" });
  });

  it("gives Clean Six only after an offence, and late balances do not stop it", () => {
    expect(codes(history(), "2027-05-02")).not.toContain("clean_six");
    const h = history({ confirmedOffences: [{ on: "2026-11-01", ruleCode: "R3" }], lateBalances: ["2027-01-10"] });
    expect(codes(h, "2027-05-01")).not.toContain("clean_six");
    expect(codes(h, "2027-05-02")).toContain("clean_six");
  });

  it("carries the best run across service but restarts the current one", () => {
    const h = history({ stints: [closed("2026-01-05", "2026-03-01", "operator_left"), open("2026-11-01")] });
    expect(operatorProgress(h, TODAY)).toMatchObject({ currentRunDays: 8, bestRunDays: 55 });
    expect(award(h, TODAY).nextAwardOn).toBe("2027-05-01");
  });

  it("ignores a date in the future", () => {
    expect(operatorProgress(history({ lateBalances: ["2027-01-01"] }), TODAY).lastBreak).toBeNull();
  });
});

describe("justEndedRun", () => {
  it("finds a notable run that ended in the last few days", () => {
    const h = history({ lateBalances: ["2026-11-05"] });
    expect(justEndedRun(h, "2026-11-08")).toEqual({ endedOn: "2026-11-05", days: 28 });
    expect(justEndedRun(h, "2026-11-09")).toBeNull();
  });

  it("ignores a short run, and repeated days after the first break", () => {
    expect(justEndedRun(history({ lateBalances: ["2026-10-12"] }), "2026-10-13")).toBeNull();
    const h = history({ lateBalances: ["2026-11-05", "2026-11-06", "2026-11-07"] });
    expect(justEndedRun(h, "2026-11-08")).toEqual({ endedOn: "2026-11-05", days: 28 });
  });

  it("is empty while the run continues", () => {
    expect(justEndedRun(history(), TODAY)).toBeNull();
  });
});

describe("the last 7 days", () => {
  it("shows finished days only, marking breaks and days before service", () => {
    const h = history({ stints: [open("2026-11-04")], lateBalances: ["2026-11-06"] });
    expect(operatorProgress(h, TODAY).recentDays).toEqual([
      { on: "2026-11-02", status: "none" },
      { on: "2026-11-03", status: "none" },
      { on: "2026-11-04", status: "clean" },
      { on: "2026-11-05", status: "clean" },
      { on: "2026-11-06", status: "missed" },
      { on: "2026-11-07", status: "clean" },
      { on: "2026-11-08", status: "clean" },
    ]);
  });
});

describe("Clean Six countdown", () => {
  it("counts from the last offence for someone shut out", () => {
    const h = history({ confirmedOffences: [{ on: "2026-11-01", ruleCode: "R3" }] });
    expect(operatorProgress(h, TODAY).cleanSix).toEqual({ reachedOn: "2027-05-02", daysLeft: 174 });
  });

  it("is not shown to someone with no offence", () => {
    expect(operatorProgress(history(), TODAY).cleanSix).toBeNull();
  });

  it("is ignored by late balances, and ends once earned", () => {
    const h = history({ confirmedOffences: [{ on: "2026-11-01", ruleCode: "R3" }], lateBalances: ["2027-01-10"] });
    expect(operatorProgress(h, "2027-02-01").cleanSix?.reachedOn).toBe("2027-05-02");
    expect(operatorProgress(h, "2027-05-02").cleanSix).toBeNull();
  });
});

describe("Honour board", () => {
  const person = (id: string, issuedOn: string, extra: Partial<OperatorHistory> = {}) => ({
    operatorId: id,
    name: `Name ${id}`,
    tricycleCode: `GRE,${id}`,
    progress: operatorProgress(history({ stints: [open(issuedOn)], ...extra }), TODAY),
  });
  const six = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06"].map((on, i) => person(String(i + 1), on));

  it("shows the five longest runs and marks you", () => {
    const board = honourBoard(six, "2");
    expect(board.rows.map((row) => row.name)).toEqual(["Name 1", "Name 2", "Name 3", "Name 4", "Name 5"]);
    expect(board.rows.map((row) => row.isYou)).toEqual([false, true, false, false, false]);
    expect(board.daysToBoard).toBeNull();
  });

  it("tells someone off the board how many days it takes, and shows nobody below", () => {
    const board = honourBoard(six, "6");
    expect(board.rows).toHaveLength(5);
    expect(board.daysToBoard).toBe(2); // 34 days against 35, plus one to pass it
  });

  it("leaves out anyone with no run yet", () => {
    expect(honourBoard([person("1", TODAY)], "1").rows).toEqual([]);
  });

  it("shows the highest milestone but no badge that hints at a past break", () => {
    const row = person("1", "2026-10-08", { lateBalances: ["2026-10-10"] });
    const board = honourBoard([row], "1");
    expect(board.rows[0]!.badges).toEqual(["Steady Rider"]);
  });
});

describe("closestFirst", () => {
  const row = (name: string, h: OperatorHistory) => ({ name, progress: operatorProgress(h, TODAY) });

  it("puts the nearest date first, then the longer run, and no date last", () => {
    const rows = [
      row("Closed", history({ status: "left" })),
      row("Later", history({ lateBalances: ["2026-11-05"] })),
      row("Newer", history({ stints: [open("2026-10-20")] })),
      row("Longer", history()),
    ];
    expect(closestFirst(rows, "consistency").map((item) => item.name)).toEqual(["Longer", "Newer", "Later", "Closed"]);
  });
});
