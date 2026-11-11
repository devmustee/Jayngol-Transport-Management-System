import type { Metadata } from "next";
import {
  AlertTriangle,
  Bike,
  Boxes,
  ClipboardCheck,
  Clock,
  PackageCheck,
  Plus,
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
import { fleetPeriod } from "@/services/balance-periods";
import { financeOverview } from "@/services/finance";
import { inspectionToday } from "@/services/inspections";
import { lowStock } from "@/services/store";
import { dashboardCounts } from "@/services/tricycles";
import { listWorkshop } from "@/services/workshop";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ pulse?: string }> }) {
  const ctx = await requirePage("dashboard.view");
  const pulse = parsePulse((await searchParams).pulse);
  const seesMoney = can(ctx.actor.role, "finance.view");
  const [counts, workshop, low, inspections, race] = await Promise.all([
    dashboardCounts(ctx),
    listWorkshop(ctx),
    can(ctx.actor.role, "stock.view") ? lowStock(ctx) : null,
    can(ctx.actor.role, "inspection.record") ? inspectionToday(ctx) : null,
    getAwardRace(ctx),
  ]);
  const [money, period] = seesMoney
    ? await Promise.all([financeOverview(ctx), pulse === "today" ? null : fleetPeriod(ctx, pulse)])
    : [null, null];

  const inspectionsLeft = inspections
    ? inspections.items.filter((item) => item.washed === null).length
    : 0;

  return (
    <>
      <PageHeader
        title={`Welcome, ${ctx.actor.name}`}
        subtitle="Operations & Fleet Command Center"
        action={
          can(ctx.actor.role, "tricycle.manage") ? (
            <div className="flex flex-wrap items-center gap-2">
              <LinkButton href="/tricycles/new" variant="secondary">
                <Plus size={16} />
                <span>Add Tricycle</span>
              </LinkButton>
              <LinkButton href="/operators/new" variant="gold">
                <Plus size={16} />
                <span>Add Operator</span>
              </LinkButton>
            </div>
          ) : null
        }
      />

      {money ? <MoneySummary money={money} period={period} basePath="/dashboard" /> : null}

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-bold uppercase tracking-wider text-muted">
          Fleet & Operations Status
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
