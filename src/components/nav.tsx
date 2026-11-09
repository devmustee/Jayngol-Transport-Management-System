"use client";

import { useState } from "react";
import {
  Award,
  BarChart3,
  Bike,
  CalendarDays,
  ChevronRight,
  ClipboardCheck,
  ClipboardList,
  LayoutDashboard,
  Menu,
  Package,
  Scale,
  ShieldAlert,
  UserCog,
  UserRound,
  Users,
  Wallet,
  Wrench,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export const ICONS = {
  home: LayoutDashboard,
  tricycles: Bike,
  operators: Users,
  money: Wallet,
  offences: ShieldAlert,
  inspect: ClipboardCheck,
  meetings: CalendarDays,
  rules: Scale,
  workshop: Wrench,
  store: Package,
  staff: UserCog,
  audit: ClipboardList,
  account: UserRound,
  awards: Award,
  reports: BarChart3,
} as const;

export type NavItem = {
  href: string;
  label: string;
  icon: keyof typeof ICONS;
  /** Shown on the phone's bottom bar. Others are reached through More/Account. */
  primary: boolean;
};

function useIsActive() {
  const pathname = usePathname();
  return (href: string) => pathname === href || pathname.startsWith(`${href}/`);
}

export function SideNav({ items }: { items: NavItem[] }) {
  const isActive = useIsActive();

  // Categorize items for desktop sidebar
  const primaryItems = items.filter(
    (i) => ["home", "tricycles", "operators", "money", "inspect"].includes(i.icon)
  );
  const operationItems = items.filter(
    (i) => ["workshop", "store", "offences", "meetings"].includes(i.icon)
  );
  const systemItems = items.filter(
    (i) => !primaryItems.includes(i) && !operationItems.includes(i)
  );

  const renderGroup = (groupItems: NavItem[], title?: string) => {
    if (groupItems.length === 0) return null;
    return (
      <div className="space-y-1">
        {title ? (
          <div className="px-3 pt-4 pb-1 text-[11px] font-bold uppercase tracking-wider text-paper/40">
            {title}
          </div>
        ) : null}
        {groupItems.map((item) => {
          const Icon = ICONS[item.icon];
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`group flex min-h-11 items-center gap-3 rounded-xl px-3 font-semibold text-sm transition-all duration-150 ${
                active
                  ? "bg-gradient-to-r from-gold to-gold-light text-ink shadow-gold-sm"
                  : "text-paper/80 hover:bg-ink-soft hover:text-gold-light"
              }`}
            >
              <Icon
                size={19}
                className={`transition-transform duration-150 group-hover:scale-110 ${
                  active ? "text-ink" : "text-paper/60 group-hover:text-gold-light"
                }`}
                aria-hidden
              />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>
    );
  };

  return (
    <nav className="mt-6 flex-1 space-y-2 overflow-y-auto pr-1" aria-label="Main">
      {renderGroup(primaryItems)}
      {renderGroup(operationItems, "Operations")}
      {renderGroup(systemItems, "Management")}
    </nav>
  );
}

export function BottomNav({ items }: { items: NavItem[] }) {
  const isActive = useIsActive();
  const [moreOpen, setMoreOpen] = useState(false);

  // Top 4 primary tabs on phone
  const primaryTabs = items.filter((item) => item.primary && item.icon !== "account").slice(0, 4);
  const secondaryItems = items.filter(
    (item) => !primaryTabs.some((pt) => pt.href === item.href)
  );

  const isAnySecondaryActive = secondaryItems.some((item) => isActive(item.href));

  return (
    <>
      {/* Mobile Bottom Bar */}
      <nav
        aria-label="Main"
        className="print:hidden fixed inset-x-0 bottom-0 z-30 grid grid-flow-col auto-cols-fr border-t border-gold-deep/20 bg-ink/95 backdrop-blur-lg pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_30px_rgba(0,0,0,0.35)] md:hidden"
      >
        {primaryTabs.map((item) => {
          const Icon = ICONS[item.icon];
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`relative flex min-h-16 flex-col items-center justify-center gap-1 text-[11px] font-bold transition-all duration-150 active:scale-95 ${
                active ? "text-gold-light" : "text-paper/65 hover:text-paper"
              }`}
            >
              {active ? (
                <span
                  className="absolute top-1.5 h-1 w-8 rounded-full bg-gold shadow-[0_0_8px_#d4a017]"
                  aria-hidden
                />
              ) : null}
              <Icon size={22} aria-hidden className={active ? "text-gold-light" : "text-paper/60"} />
              <span>{item.label}</span>
            </Link>
          );
        })}

        {/* 5th Tab: More Drawer Trigger */}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-expanded={moreOpen}
          aria-label="More navigation options"
          className={`relative flex min-h-16 flex-col items-center justify-center gap-1 text-[11px] font-bold transition-all duration-150 active:scale-95 ${
            isAnySecondaryActive || moreOpen ? "text-gold-light" : "text-paper/65 hover:text-paper"
          }`}
        >
          {isAnySecondaryActive ? (
            <span
              className="absolute top-1.5 h-1 w-8 rounded-full bg-gold shadow-[0_0_8px_#d4a017]"
              aria-hidden
            />
          ) : null}
          <Menu size={22} aria-hidden className={isAnySecondaryActive ? "text-gold-light" : "text-paper/60"} />
          <span>More</span>
        </button>
      </nav>

      {/* Spring Bottom Sheet for 'More' */}
      {moreOpen ? (
        <div className="fixed inset-0 z-50 flex flex-col justify-end md:hidden">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
            onClick={() => setMoreOpen(false)}
            aria-hidden
          />

          {/* Sheet Drawer */}
          <div
            role="dialog"
            aria-label="All Navigation Items"
            className="relative z-10 max-h-[85vh] overflow-y-auto rounded-t-3xl border-t border-gold-deep/30 bg-ink p-5 pb-12 shadow-2xl animate-in slide-in-from-bottom duration-200"
          >
            {/* Drag handle */}
            <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-paper/20" />

            <div className="flex items-center justify-between border-b border-paper/10 pb-3">
              <h3 className="text-base font-extrabold text-gold-light">All Modules & Tools</h3>
              <button
                type="button"
                onClick={() => setMoreOpen(false)}
                className="flex h-10 w-10 items-center justify-center rounded-full bg-ink-soft text-paper/80 hover:text-paper"
                aria-label="Close menu"
              >
                <X size={20} />
              </button>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-2">
              {secondaryItems.map((item) => {
                const Icon = ICONS[item.icon];
                const active = isActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMoreOpen(false)}
                    className={`flex min-h-12 items-center justify-between rounded-xl px-4 text-sm font-semibold transition-all ${
                      active
                        ? "bg-gold text-ink font-bold shadow-gold-sm"
                        : "bg-ink-soft/70 text-paper hover:bg-ink-soft"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <Icon
                        size={20}
                        className={active ? "text-ink" : "text-gold-light"}
                        aria-hidden
                      />
                      <span>{item.label}</span>
                    </div>
                    <ChevronRight
                      size={18}
                      className={active ? "text-ink" : "text-paper/40"}
                      aria-hidden
                    />
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
