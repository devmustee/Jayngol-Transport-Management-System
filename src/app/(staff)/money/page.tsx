import type { Metadata } from "next";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeftRight,
  Award,
  Banknote,
  BarChart3,
  BookOpen,
  CalendarDays,
  CalendarRange,
  ChevronRight,
  CircleDollarSign,
  Clock,
  CreditCard,
  FileSpreadsheet,
  HandCoins,
  Landmark,
  Receipt,
  Scale,
  ShieldAlert,
  Wallet,
} from "lucide-react";
import { BalancesByPeriod } from "@/components/balance-periods";
import { MoneySummary } from "@/components/money-summary";
import { LinkButton, PageHeader } from "@/components/ui";
import { METHOD_LABELS } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { parsePulse } from "@/lib/periods";
import { requirePage } from "@/lib/session";
import { fleetPeriod, fleetToday } from "@/services/balance-periods";
import { financeOverview } from "@/services/finance";

export const metadata: Metadata = { title: "Money" };

const FINANCE_SECTIONS = [
  {
    title: "Cash and payments",
    items: [
      {
        href: "/payments",
        label: "Payments",
        desc: "Every payment and its receipt",
        icon: Receipt,
      },
      {
        href: "/deposits",
        label: "Deposits",
        desc: "Money held for operators, kept apart from collections",
        icon: Wallet,
      },
      {
        href: "/cash",
        label: "Cash close",
        desc: "Assistant Manager closes daily, Manager closes weekly",
        icon: Banknote,
      },
      {
        href: "/cash-book",
        label: "Cash book",
        desc: "Every naira in and out, by date",
        icon: BookOpen,
      },
      {
        href: "/transfers",
        label: "Move money",
        desc: "Banking cash, staff handovers and cash to the Owner",
        icon: ArrowLeftRight,
      },
      {
        href: "/bank",
        label: "Bank check",
        desc: "Confirm transfers and reconcile each month",
        icon: Landmark,
      },
      {
        href: "/expenses",
        label: "Expenses",
        desc: "Advances and their receipts",
        icon: FileSpreadsheet,
      },
      {
        href: "/loans",
        label: "Loans",
        desc: "Money lent to operators and what is left to collect",
        icon: HandCoins,
      },
    ],
  },
  {
    title: "Problems to follow up",
    items: [
      {
        href: "/arrears",
        label: "Unpaid balances",
        desc: "Who owes, and since when",
        icon: Clock,
      },
      {
        href: "/sacking",
        label: "Sacking alerts",
        desc: "Operators at 5 unpaid days, and appeals",
        icon: AlertTriangle,
      },
      {
        href: "/offences",
        label: "Offences and fines",
        desc: "Broken rules and their fines",
        icon: Scale,
      },
    ],
  },
  {
    title: "Reports",
    items: [
      {
        href: "/money/year",
        label: "Annual balance",
        desc: "The year by month and week",
        icon: CalendarRange,
      },
      {
        href: "/reports",
        label: "Monthly reports",
        desc: "Monthly summaries to view or download",
        icon: BarChart3,
      },
      {
        href: "/awards",
        label: "Awards",
        desc: "Who is close to an award",
        icon: Award,
      },
      {
        href: "/no-balance-days",
        label: "No-balance days",
        desc: "Holidays with no daily balance",
        icon: CalendarDays,
      },
    ],
  },
];

export default async function MoneyPage({ searchParams }: { searchParams: Promise<{ pulse?: string }> }) {
  const ctx = await requirePage("finance.view");
  const pulse = parsePulse((await searchParams).pulse);
  const [money, week, month, today] = await Promise.all([
    financeOverview(ctx),
    fleetPeriod(ctx, "week"),
    fleetPeriod(ctx, "month"),
    pulse === "today" ? fleetToday(ctx) : null,
  ]);

  return (
    <>
      <PageHeader
        title="Money"
        subtitle="Collections, cash and arrears"
        action={
          <LinkButton href="/money/year">
            <CalendarRange size={16} />
            <span>Annual balance</span>
          </LinkButton>
        }
      />

      <MoneySummary money={money} period={pulse === "week" ? week : pulse === "month" ? month : null} today={today} basePath="/money" />

      {/* Collection Methods */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted">
            Today by method:
          </span>
          {money.byMethod.length > 0 ? (
            money.byMethod.map((m) => (
              <span
                key={m.method}
                className="inline-flex items-center gap-1.5 rounded-lg bg-gold-wash px-2.5 py-1 text-xs font-bold text-gold-deep border border-gold-light/40"
              >
                {m.method === "cash" ? <Banknote size={14} /> : <CreditCard size={14} />}
                <span>
                  {METHOD_LABELS[m.method]}: {formatNaira(m.total)}
                </span>
              </span>
            ))
          ) : (
            <span className="text-xs text-muted">No collections recorded yet today.</span>
          )}
        </div>

        {money.bankToCheck > 0 ? (
          <Link href="/bank" className="flex min-h-11 items-center gap-1.5 text-xs font-semibold text-warning">
            <Landmark size={14} />
            <span>
              {money.bankToCheck} transfer and POS payment{money.bankToCheck === 1 ? "" : "s"} to confirm against the bank
            </span>
          </Link>
        ) : null}
      </div>

      <BalancesByPeriod week={week} month={month} />

      {/* Financial Operations Grid */}
      <div className="space-y-6">
        {FINANCE_SECTIONS.map((section) => (
          <div key={section.title}>
            <h3 className="mb-3 text-xs font-medium text-muted">
              {section.title}
            </h3>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {section.items.map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="flex min-h-16 items-center justify-between gap-3 rounded-2xl border border-line bg-card p-4 transition-colors duration-150 hover:border-line-strong hover:bg-card-subtle"
                  >
                    <div className="flex items-center gap-3.5 min-w-0">
                      <Icon size={19} aria-hidden className="shrink-0 text-muted" />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-ink">
                          {item.label}
                        </div>
                        <div className="mt-0.5 text-xs leading-snug text-muted">{item.desc}</div>
                      </div>
                    </div>
                    <ChevronRight
                      size={18}
                      className="shrink-0 text-muted/50"
                    />
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
