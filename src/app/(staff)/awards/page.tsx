import type { Metadata } from "next";
import Link from "next/link";
import { CalendarDays, ClipboardCheck, Star, Trophy } from "lucide-react";
import { approveAwardAction, rejectAwardAction } from "@/app/actions";
import { isBehind, isNear, RaceList, STAGE_LABELS, trackOf } from "@/components/award-tracker";
import { ActionForm, Field, SubmitButton, TextareaField } from "@/components/form";
import { Card, Details, Disclosure, Empty, PageHeader, StatTile } from "@/components/ui";
import { AWARD_TYPES, closestFirst, firstOfNextMonth, type AwardStage, type AwardType } from "@/lib/award-progress";
import { daysBetween } from "@/lib/clock";
import { AWARD_LABELS, AWARD_PRIZES, formatDate } from "@/lib/format";
import { can } from "@/lib/permissions";
import { requirePage } from "@/lib/session";
import { getAwardRace } from "@/services/award-tracker";
import { listAwards } from "@/services/awards";

export const metadata: Metadata = { title: "Awards" };

const STAGES = Object.keys(STAGE_LABELS) as AwardStage[];

function FilterLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={`inline-flex min-h-11 items-center rounded-full border px-3.5 text-sm font-bold transition-colors ${
        active ? "border-ink bg-ink text-gold-light" : "border-line bg-card text-ink hover:border-gold-deep/50 hover:bg-gold-wash"
      }`}
    >
      {children}
    </Link>
  );
}

export default async function AwardsPage({
  searchParams,
}: {
  searchParams: Promise<{ award?: string; stage?: string; inspect?: string }>;
}) {
  const ctx = await requirePage("awards.track");
  const canDecide = can(ctx.actor.role, "finance.view");
  const [race, decisions, params] = await Promise.all([
    getAwardRace(ctx),
    canDecide ? listAwards(ctx) : null,
    searchParams,
  ]);

  const type: AwardType = AWARD_TYPES.includes(params.award as AwardType) ? (params.award as AwardType) : "consistency";
  const stage = STAGES.includes(params.stage as AwardStage) ? (params.stage as AwardStage) : null;
  const inspectOnly = params.inspect === "1";
  const href = (query: { award?: AwardType; stage?: AwardStage | null; inspect?: boolean }) => {
    const search = new URLSearchParams();
    const award = query.award ?? type;
    if (award !== "consistency") search.set("award", award);
    if (query.stage) search.set("stage", query.stage);
    if (query.inspect) search.set("inspect", "1");
    const text = search.toString();
    return text ? `/awards?${text}` : "/awards";
  };

  const ranked = closestFirst(race.operators, type);
  const stageOf = (row: (typeof ranked)[number]) => trackOf(row.progress, type).stage;
  const count = (wanted: AwardStage) => ranked.filter((row) => stageOf(row) === wanted).length;
  const behind = ranked.filter((row) => isBehind(trackOf(row.progress, type)));
  const inspectFirst = behind.filter((row) => isNear(trackOf(row.progress, type)));
  const shown = ranked.filter((row) => (!stage || stageOf(row) === stage) && (!inspectOnly || behind.includes(row)));

  const nextAward = firstOfNextMonth(race.today);
  const [day, month, year] = formatDate(nextAward).split(" ");
  const waiting = decisions?.waiting ?? [];

  return (
    <>
      <PageHeader
        title="Awards"
        subtitle="Who is close, and who needs help getting there"
        back={canDecide ? { href: "/money", label: "Money" } : { href: "/dashboard", label: "Home" }}
      />
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
          <StatTile label="Ready" value={count("ready")} href={href({ stage: "ready" })} icon={Trophy} tone="gold" subtext="At the coming award date" />
          <StatTile label="Close" value={count("close")} href={href({ stage: "close" })} icon={Star} tone="gold" subtext="At the award date after" />
          <StatTile
            label="Inspections behind"
            value={behind.length}
            href={href({ inspect: true })}
            icon={ClipboardCheck}
            tone={behind.length > 0 ? "warning" : "good"}
            subtext="Below the 80% needed"
          />
          <StatTile
            label="Next award date"
            value={`${day} ${month}`}
            href="#race"
            icon={CalendarDays}
            tone="plain"
            subtext={`${year} · ${daysBetween(race.today, nextAward)} days away`}
          />
        </div>

        {!canDecide || inspectFirst.length > 0 ? (
          <Card title="Inspect these first" subtitle={`Near the ${AWARD_LABELS[type]} award, but behind on inspections`}>
            {inspectFirst.length === 0 ? (
              <Empty>Nobody close to this award is behind on inspections.</Empty>
            ) : (
              <RaceList rows={inspectFirst} type={type} />
            )}
          </Card>
        ) : null}

        {waiting.map(({ candidate, operatorName, facts, waived }) => (
          <Card key={candidate.id} title={`${operatorName}: ${AWARD_LABELS[candidate.type]}`} subtitle="Waiting for your decision">
            <Details
              rows={[
                ["Prize", AWARD_PRIZES[candidate.type]],
                ["Period", `${formatDate(candidate.periodFrom)} to ${formatDate(candidate.periodTo)}`],
                ["Service started", formatDate((facts.serviceStartedOn ?? facts.firstIssuedOn)!)],
                ["Inspection coverage", `${facts.coveragePercent}% (${facts.inspectedDays} of ${facts.workingDays} days)`],
                ["Late balances in period", String(facts.lateBalances)],
                ["Offences in period", String(facts.offencesInPeriod)],
                ["Offences waived in period", waived.total > 0 ? `${waived.total} (by ${waived.names ?? "unknown"})` : "0"],
                ["Offences on record", String(facts.offencesEver)],
              ]}
            />
            {decisions?.canApprove ? (
              <div className="mt-3 space-y-3">
                <ActionForm action={approveAwardAction.bind(null, candidate.id)}>
                  <Field
                    name="given"
                    label="What was given"
                    defaultValue={AWARD_PRIZES[candidate.type]}
                    hint={candidate.type === "law_abiding" ? "Write the amount, for example Cash 50,000." : undefined}
                    autoComplete="off"
                  />
                  <SubmitButton>Approve award</SubmitButton>
                </ActionForm>
                <Disclosure label="Reject this award">
                  <ActionForm action={rejectAwardAction.bind(null, candidate.id)}>
                    <TextareaField name="reason" label="Reason" />
                    <SubmitButton tone="plain">Reject</SubmitButton>
                  </ActionForm>
                </Disclosure>
              </div>
            ) : null}
          </Card>
        ))}

        <div id="race" className="scroll-mt-20">
          <Card title="Award race" subtitle={`${race.operators.length} active operators, closest first`}>
            <div className="mb-3 flex flex-wrap gap-2" aria-label="Choose an award">
              {AWARD_TYPES.map((option) => (
                <FilterLink key={option} href={href({ award: option })} active={option === type}>
                  {AWARD_LABELS[option]}
                </FilterLink>
              ))}
            </div>
            <div className="mb-3 flex flex-wrap gap-2 border-t border-line/60 pt-3" aria-label="Filter by stage">
              <FilterLink href={href({})} active={!stage && !inspectOnly}>All</FilterLink>
              {STAGES.filter((option) => count(option) > 0).map((option) => (
                <FilterLink key={option} href={href({ stage: option })} active={stage === option}>
                  {STAGE_LABELS[option]} ({count(option)})
                </FilterLink>
              ))}
              {behind.length > 0 ? (
                <FilterLink href={href({ inspect: true })} active={inspectOnly}>
                  Inspections behind ({behind.length})
                </FilterLink>
              ) : null}
            </div>
            {shown.length === 0 ? <Empty>No operator matches this filter.</Empty> : <RaceList rows={shown} type={type} />}
          </Card>
        </div>

        {decisions ? (
          <Card title="Hall of winners">
            {decisions.given.length === 0 ? (
              <Empty>The first winners will appear here.</Empty>
            ) : (
              <ul className="divide-y divide-line">
                {decisions.given.map((award) => (
                  <li key={award.id} className="flex items-center gap-3 py-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-gold-light/60 bg-gold-wash text-gold-deep">
                      <Trophy size={18} aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold">{award.operatorName}</div>
                      <div className="text-sm text-muted">{AWARD_LABELS[award.type]}: {award.given} · {formatDate(award.givenOn)}</div>
                    </div>
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
