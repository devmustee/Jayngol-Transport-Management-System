import { formatNaira } from "@/lib/money";
import { ContributionTile } from "@/components/contribution-tile";
import { businessDate, daysBetween } from "@/lib/clock";
import { contributionSummary } from "@/services/contributions";
import type { Metadata } from "next";
import {
  AlertTriangle,
  Bike,
  Boxes,
  ClipboardCheck,
  HandCoins,
  Clock,
  PackageCheck,
  Plus,
  Receipt,
  UserMinus,
  Users,
  Wrench,
} from "lucide-react";
import { AwardRaceCard } from "@/components/award-tracker";
import { MoneySummary } from "@/components/money-summary";
import { LinkButton, PageHeader, StatTile } from "@/components/ui";
import { parsePulse } from "@/lib/periods";
import { can } from "@/lib/permissions";
import { requirePage } from "@/lib/session";
import { getAwardRace } from "@/services/award-tracker";
import { fleetPeriod, fleetToday } from "@/services/balance-periods";
import { financeOverview } from "@/services/finance";
import { depositsToSettle } from "@/services/deposit-settlements";
import { waitingLoanRequests } from "@/services/loan-requests";
import Link from "next/link";
import { inspectionToday } from "@/services/inspections";
import { lowStock } from "@/services/store";
import { dashboardCounts } from "@/services/tricycles";
import { listWorkshop } from "@/services/workshop";

/** "today", "1 day ago" or "N days ago", in Lagos days. */
function waitedDays(from: Date, now: Date) {
  const days = daysBetween(businessDate(from), businessDate(now));
  return days === 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
}

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ pulse?: string }> }) {
  const ctx = await requirePage("dashboard.view");
  const pulse = parsePulse((await searchParams).pulse);
  const seesMoney = can(ctx.actor.role, "finance.view");
  const [counts, workshop, low, inspections, race, money, period, today, contributions, toSettle, loanAsks] = await Promise.all([
    dashboardCounts(ctx),
    listWorkshop(ctx),
    can(ctx.actor.role, "stock.view") ? lowStock(ctx) : null,
    can(ctx.actor.role, "inspection.record") ? inspectionToday(ctx) : null,
    getAwardRace(ctx),
    seesMoney ? financeOverview(ctx) : null,
    seesMoney && pulse !== "today" ? fleetPeriod(ctx, pulse) : null,
    seesMoney && pulse === "today" ? fleetToday(ctx) : null,
    seesMoney ? contributionSummary(ctx) : null,
    can(ctx.actor.role, "deposit.settle") ? depositsToSettle() : null,
    can(ctx.actor.role, "loan.approve") ? waitingLoanRequests() : null,
  ]);

  const inspectionsLeft = inspections
    ? inspections.items.filter((item) => item.washed === null).length
    : 0;

  return (
    <>
      <PageHeader
        title={`Welcome, ${ctx.actor.name}`}
        subtitle="Today at a glance"
        action={
          can(ctx.actor.role, "tricycle.manage") ||
          can(ctx.actor.role, "expense.record") ||
          can(ctx.actor.role, "loan.approve") ||
          can(ctx.actor.role, "loan.request") ? (
            <div className="flex flex-wrap items-center gap-2">
              {can(ctx.actor.role, "expense.record") ? (
                <LinkButton href="/expenses?record=1">
                  <Receipt size={16} />
                  <span>Record an expense</span>
                </LinkButton>
              ) : null}
              {can(ctx.actor.role, "loan.approve") ? (
                <LinkButton href="/loans?give=1" variant="secondary">
                  <HandCoins size={16} />
                  <span>Give a loan</span>
                </LinkButton>
              ) : can(ctx.actor.role, "loan.request") ? (
                <LinkButton href="/loans?give=1" variant="secondary">
                  <HandCoins size={16} />
                  <span>Request a loan</span>
                </LinkButton>
              ) : null}
              {can(ctx.actor.role, "tricycle.manage") ? (
                <>
                  <LinkButton href="/tricycles/new" variant="secondary">
                    <Plus size={16} />
                    <span>Add tricycle</span>
                  </LinkButton>
                  <LinkButton href="/operators/new" variant="gold">
                    <Plus size={16} />
                    <span>Add operator</span>
                  </LinkButton>
                </>
              ) : null}
            </div>
          ) : null
        }
      />

      {loanAsks && loanAsks.count > 0 ? (
        <Link
          href="/loans"
          className="mb-4 flex min-h-12 items-center justify-between gap-3 rounded-xl border border-gold/40 bg-gold-wash px-4 py-3 text-sm text-ink hover:border-gold"
        >
          <span>
            <span className="font-semibold">
              {loanAsks.count} loan request{loanAsks.count === 1 ? "" : "s"} waiting
            </span>
            {loanAsks.oldest ? ` · oldest ${waitedDays(loanAsks.oldest, ctx.clock())}` : ""}
          </span>
          <span className="shrink-0 font-semibold text-gold-deep">Decide</span>
        </Link>
      ) : null}

      {toSettle && toSettle.length > 0 ? (
        <Link
          href="/deposits"
          className="mb-4 flex min-h-12 items-center justify-between gap-3 rounded-xl border border-gold/40 bg-gold-wash px-4 py-3 text-sm text-ink hover:border-gold"
        >
          <span>
            <span className="font-semibold">
              {toSettle.length} deposit{toSettle.length === 1 ? "" : "s"} to settle
            </span>{" "}
            · {formatNaira(toSettle.reduce((sum, row) => sum + row.held, 0))} held for operators who left
          </span>
          <span className="shrink-0 font-semibold text-gold-deep">Settle</span>
        </Link>
      ) : null}

      {money ? <MoneySummary money={money} period={period} today={today} basePath="/dashboard" /> : null}

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted">
          Fleet today
        </h2>
        <span className="text-xs text-muted">Live sync</span>
      </div>

      <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 lg:grid-cols-3">
        {inspections ? (
          <StatTile
            label="Inspections left today"
            value={inspectionsLeft}
            href="/inspections"
            icon={ClipboardCheck}
            tone={inspectionsLeft > 0 ? "warning" : "good"}
            subtext={inspectionsLeft > 0 ? "Requires field check" : "All complete"}
          />
        ) : null}

        {contributions ? <ContributionTile summary={contributions} today={businessDate(ctx.clock())} /> : null}

        <StatTile
          label="With operators"
          value={counts.issued}
          href="/tricycles?status=issued"
          icon={Bike}
          tone="good"
          subtext="Earning daily balance"
        />

        <StatTile
          label="In stock"
          value={counts.inStock}
          href="/tricycles?status=in_stock"
          icon={PackageCheck}
          tone="gold"
          subtext="Ready for assignment"
        />

        <StatTile
          label="Off road"
          value={counts.offRoad}
          href="/tricycles?status=off_road"
          icon={AlertTriangle}
          tone={counts.offRoad > 0 ? "bad" : "plain"}
          subtext={counts.offRoad > 0 ? "Under repair" : "Zero off road"}
        />

        <StatTile
          label="Services due today"
          value={workshop.dueToday.length}
          href="/workshop"
          icon={Wrench}
          tone={workshop.dueToday.length > 0 ? "warning" : "plain"}
          subtext="Scheduled maintenance"
        />

        <StatTile
          label="Services overdue"
          value={workshop.overdue.length}
          href="/workshop"
          icon={Clock}
          tone={workshop.overdue.length > 0 ? "bad" : "plain"}
          subtext={workshop.overdue.length > 0 ? "Late for workshop" : "None overdue"}
        />

        {low ? (
          <StatTile
            label="Store items low"
            value={low.length}
            href="/store"
            icon={Boxes}
            tone={low.length > 0 ? "warning" : "good"}
            subtext={low.length > 0 ? "Reorder required" : "Inventory healthy"}
          />
        ) : null}

        <StatTile
          label="Active operators"
          value={counts.activeOperators}
          href="/operators?status=active"
          icon={Users}
          tone="good"
          subtext="In good standing"
        />

        <StatTile
          label="Operators without tricycle"
          value={counts.operatorsWithoutTricycle}
          href="/operators?status=active"
          icon={UserMinus}
          tone="plain"
          subtext="Awaiting assignment"
        />
      </div>

      <div className="mt-6">
        <AwardRaceCard operators={race.operators} />
      </div>
    </>
  );
}
