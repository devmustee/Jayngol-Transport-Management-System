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
  Plus,
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
import { fleetPeriod } from "@/services/balance-periods";
import { financeOverview } from "@/services/finance";

export const metadata: Metadata = { title: "Money" };

const FINANCE_SECTIONS = [
  {
    title: "Cash Desk & Ledger",
    items: [
      {
        href: "/payments",
        label: "Payments & Receipts",
        desc: "All recorded collections and receipts",
        icon: Receipt,
      },
      {
        href: "/deposits",
        label: "Operator Deposits",
        desc: "Money held for operators, kept apart from collections",
        icon: Wallet,
      },
      {
        href: "/cash",
        label: "Cash Close",
        desc: "Assistant Manager closes daily, Manager closes weekly",
        icon: Banknote,
      },
      {
        href: "/cash-book",
        label: "Cash Book Ledger",
        desc: "Chronological cash inflows & outflows",
        icon: BookOpen,
      },
      {
        href: "/transfers",
        label: "Move Money",
        desc: "Banking cash, staff handovers and cash to the Owner",
        icon: ArrowLeftRight,
      },
      {
        href: "/bank",
        label: "Bank Check",
        desc: "Confirm transfers and reconcile each month",
        icon: Landmark,
      },
      {
        href: "/expenses",
        label: "Expense Advances",
        desc: "Operating advances and verified receipts",
        icon: FileSpreadsheet,
      },
      {
        href: "/loans",
        label: "Operator Loans",
        desc: "Money lent to operators and what is left to collect",
        icon: HandCoins,
      },
    ],
  },
  {
    title: "Risk & Compliance",
    items: [
      {
        href: "/arrears",
        label: "Unpaid Balances (Arrears)",
        desc: "Overdue balances and delinquent accounts",
        icon: Clock,
      },
      {
        href: "/sacking",
        label: "Sacking Alerts & Appeals",
        desc: "Drivers reaching 5 unpaid days threshold",
        icon: AlertTriangle,
      },
      {
        href: "/offences",
        label: "Offences & Fines",
        desc: "Rule violations and penalty charges",
        icon: Scale,
      },
    ],
  },
  {
    title: "Reports & Governance",
    items: [
      {
        href: "/money/year",
        label: "Annual Balance",
        desc: "The whole year by month and week, with subtotals and totals",
        icon: CalendarRange,
      },
      {
        href: "/reports",
        label: "Financial Reports",
        desc: "Monthly summaries and fleet performance",
        icon: BarChart3,
      },
      {
        href: "/awards",
        label: "Driver Excellence Awards",
        desc: "Reward candidates and bonus distributions",
        icon: Award,
      },
      {
        href: "/no-balance-days",
        label: "No-Balance Holidays",
        desc: "Exempt public holidays from daily balance",
        icon: CalendarDays,
      },
    ],
  },
];

export default async function MoneyPage({ searchParams }: { searchParams: Promise<{ pulse?: string }> }) {
  const ctx = await requirePage("finance.view");
  const pulse = parsePulse((await searchParams).pulse);
  const [money, week, month] = await Promise.all([
    financeOverview(ctx),
    fleetPeriod(ctx, "week"),
    fleetPeriod(ctx, "month"),
  ]);

  return (
    <>
      <PageHeader
        title="Financial Management"
        subtitle="Daily cash collection, cashier reconciliation and arrears management"
        action={
          <>
            <LinkButton href="/money/year">
              <CalendarRange size={16} />
              <span>Annual Balance</span>
            </LinkButton>
            {money.canCollect ? (
              <LinkButton href="/payments/new" variant="gold">
                <Plus size={16} />
                <span>Take Payment</span>
              </LinkButton>
            ) : null}
          </>
        }
      />

      <MoneySummary money={money} period={pulse === "week" ? week : pulse === "month" ? month : null} basePath="/money" />

      {/* Collection Methods */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-bold uppercase tracking-wider text-muted">
            Today by Method:
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
            <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-muted">
              {section.title}
            </h3>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {section.items.map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="group flex min-h-16 items-center justify-between gap-3 rounded-2xl border border-line bg-card p-4 shadow-premium transition-all duration-150 hover:-translate-y-0.5 hover:border-gold hover:shadow-md"
                  >
                    <div className="flex items-center gap-3.5 min-w-0">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gold-wash/50 border border-gold-light/40 text-gold-deep transition-transform group-hover:scale-105">
                        <Icon size={19} />
                      </div>
                      <div className="min-w-0">
                        <div className="font-extrabold text-sm text-ink group-hover:text-gold-deep transition-colors">
                          {item.label}
                        </div>
                        <div className="mt-0.5 text-xs leading-snug text-muted">{item.desc}</div>
                      </div>
                    </div>
                    <ChevronRight
                      size={18}
                      className="text-muted/60 transition-transform group-hover:translate-x-0.5 group-hover:text-gold-deep shrink-0"
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
