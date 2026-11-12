"use client";

import { useEffect, useState } from "react";
import {
  Award,
  BarChart3,
  Bike,
  CalendarRange,
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
import Link, { useLinkStatus } from "next/link";
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
  annual: CalendarRange,
} as const;

export type NavItem = {
  href: string;
  label: string;
  icon: keyof typeof ICONS;
  /** Shown on the phone's bottom bar. Others are reached through More/Account. */
  primary: boolean;
};

/** Inside a menu link: pulses its icon from the tap until the page arrives. */
function NavIcon({ icon: Icon, size, className }: { icon: (typeof ICONS)[keyof typeof ICONS]; size: number; className: string }) {
  const { pending } = useLinkStatus();
  return <Icon size={size} aria-hidden className={`${className} ${pending ? "animate-pulse text-gold-light" : ""}`} />;
}

const covers = (href: string, pathname: string) => pathname === href || pathname.startsWith(`${href}/`);

/**
 * Only the closest menu item is current: on /money/year that is "Annual
 * balance", not "Money" as well.
 */
function useIsActive(items: NavItem[]) {
  const pathname = usePathname();
  const best = items
    .filter((item) => covers(item.href, pathname))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return (href: string) => best?.href === href;
}

export function SideNav({ items }: { items: NavItem[] }) {
  const isActive = useIsActive(items);

  // Categorize items for desktop sidebar
  const primaryItems = items.filter(
    (i) => ["home", "tricycles", "operators", "money", "annual", "inspect"].includes(i.icon)
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
          <div className="px-3 pt-5 pb-1 text-xs text-paper/40">
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
              className={`flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm transition-colors duration-150 ${
                active ? "bg-paper/10 font-semibold text-paper" : "text-paper/65 hover:bg-paper/5 hover:text-paper"
              }`}
            >
              <NavIcon
                icon={Icon}
                size={19}
                className={active ? "text-gold-light" : "text-paper/50"}
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
  const isActive = useIsActive(items);
  const [moreOpen, setMoreOpen] = useState(false);

  // Top 4 primary tabs on phone
  const primaryTabs = items.filter((item) => item.primary && item.icon !== "account").slice(0, 4);
  const secondaryItems = items.filter(
    (item) => !primaryTabs.some((pt) => pt.href === item.href)
  );

  const isAnySecondaryActive = secondaryItems.some((item) => isActive(item.href));

  // While the menu is open the page behind it stays still, and Escape closes it.
  useEffect(() => {
    if (!moreOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  return (
    <>
      {/* Mobile Bottom Bar */}
      <nav
        aria-label="Main"
        className="print:hidden fixed inset-x-0 bottom-0 z-30 grid grid-flow-col auto-cols-fr border-t border-paper/10 bg-ink pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {primaryTabs.map((item) => {
          const Icon = ICONS[item.icon];
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`relative flex min-h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors duration-150 active:scale-95 ${
                active ? "text-paper" : "text-paper/55 hover:text-paper"
              }`}
            >
              {active ? (
                <span
                  className="absolute top-0 h-0.5 w-8 rounded-full bg-gold"
                  aria-hidden
                />
              ) : null}
              <NavIcon icon={Icon} size={22} className={active ? "text-gold-light" : "text-paper/50"} />
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
          className={`relative flex min-h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors duration-150 active:scale-95 ${
            isAnySecondaryActive || moreOpen ? "text-paper" : "text-paper/55 hover:text-paper"
          }`}
        >
          {isAnySecondaryActive ? (
            <span
              className="absolute top-0 h-0.5 w-8 rounded-full bg-gold"
              aria-hidden
            />
          ) : null}
          <Menu size={22} aria-hidden className={isAnySecondaryActive ? "text-gold-light" : "text-paper/50"} />
          <span>More</span>
        </button>
      </nav>

      {/* Spring Bottom Sheet for 'More' */}
      {moreOpen ? (
        <div className="fixed inset-0 z-50 flex flex-col justify-end md:hidden">
          {/* Backdrop */}
          <div
            className="fixed inset-0 animate-fade-in bg-black/60 backdrop-blur-sm"
            onClick={() => setMoreOpen(false)}
            aria-hidden
          />

          {/* Sheet Drawer */}
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Menu"
            className="relative z-10 max-h-[85dvh] animate-sheet-up overflow-y-auto overscroll-contain rounded-t-3xl bg-ink p-5 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]"
          >
            {/* Drag handle */}
            <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-paper/20" />

            <div className="flex items-center justify-between border-b border-paper/10 pb-3">
              <h2 className="text-base font-semibold text-paper">Menu</h2>
              <button
                type="button"
                onClick={() => setMoreOpen(false)}
                className="flex h-11 w-11 items-center justify-center rounded-full bg-ink-soft text-paper/80 hover:text-paper"
                aria-label="Close menu"
              >
                <X size={20} />
              </button>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
              {secondaryItems.map((item) => {
                const Icon = ICONS[item.icon];
                const active = isActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMoreOpen(false)}
                    className={`flex min-h-12 items-center justify-between rounded-xl px-4 text-sm transition-colors ${
                      active ? "bg-paper/10 font-semibold text-paper" : "bg-paper/5 text-paper/80 hover:bg-paper/10"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <Icon
                        size={20}
                        className={active ? "text-gold-light" : "text-paper/50"}
                        aria-hidden
                      />
                      <span>{item.label}</span>
                    </div>
                    <ChevronRight
                      size={18}
                      className="text-paper/30"
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
