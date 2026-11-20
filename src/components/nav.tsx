"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Award,
  BarChart3,
  BookOpen,
  Bike,
  CalendarRange,
  CalendarDays,
  ChevronDown,
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
  guide: BookOpen,
} as const;

export type NavItem = {
  href: string;
  label: string;
  icon: keyof typeof ICONS;
  /** Shown on the phone's bottom bar. Others are reached through More/Account. */
  primary: boolean;
  /** Other pages that belong to this item, such as the Money pages that live outside /money. */
  also?: string[];
};

/** Inside a menu link: pulses its icon from the tap until the page arrives. */
function NavIcon({ icon: Icon, size, className }: { icon: (typeof ICONS)[keyof typeof ICONS]; size: number; className: string }) {
  const { pending } = useLinkStatus();
  return <Icon size={size} aria-hidden className={`${className} ${pending ? "animate-pulse text-gold-light" : ""}`} />;
}

const covers = (href: string, pathname: string) => pathname === href || pathname.startsWith(`${href}/`);

/** How closely an item matches the page: the length of its longest covering address, or 0. */
const closeness = (item: NavItem, pathname: string) =>
  Math.max(0, ...[item.href, ...(item.also ?? [])].filter((href) => covers(href, pathname)).map((href) => href.length));

/**
 * Only the closest menu item is current: on /money/year that is "Annual
 * balance", not "Money" as well, and on /cash it is "Money".
 */
function useIsActive(items: NavItem[]) {
  const pathname = usePathname();
  const best = items
    .map((item) => ({ item, score: closeness(item, pathname) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.item;
  return (href: string) => best?.href === href;
}

export function SideNav({ items }: { items: NavItem[] }) {
  const isActive = useIsActive(items);
  const listRef = useRef<HTMLElement>(null);
  const [moreBelow, setMoreBelow] = useState(false);
  const measure = useCallback(() => {
    const el = listRef.current;
    if (el) setMoreBelow(el.scrollTop + el.clientHeight < el.scrollHeight - 4);
  }, []);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  // Categorize items for desktop sidebar
  const primaryItems = items.filter(
    (i) => ["home", "tricycles", "operators", "money", "annual", "inspect"].includes(i.icon)
  );
  const operationItems = items.filter(
    (i) => ["workshop", "store", "offences", "meetings"].includes(i.icon)
  );
  // Account is left out: the name at the foot of the menu opens it.
  const systemItems = items.filter(
    (i) => !primaryItems.includes(i) && !operationItems.includes(i) && i.icon !== "account"
  );

  const renderGroup = (groupItems: NavItem[], title?: string) => {
    if (groupItems.length === 0) return null;
    return (
      <div className="space-y-1">
        {title ? (
          <div className="px-3 pt-5 low:pt-3 pb-1 text-xs text-paper/40">
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
              className={`flex min-h-11 low:min-h-9 items-center gap-3 rounded-xl px-3 text-sm transition-colors duration-150 ${
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
    <div className="relative mt-6 low:mt-3 flex min-h-0 flex-1 flex-col">
      <nav
        ref={listRef}
        onScroll={measure}
        data-tour="menu"
        className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 [scrollbar-color:rgb(251_247_236/0.25)_transparent] [scrollbar-width:thin] low:space-y-1"
        aria-label="Main"
      >
        {renderGroup(primaryItems)}
        {renderGroup(operationItems, "Operations")}
        {renderGroup(systemItems, "Management")}
      </nav>
      {/* Shows there is more below while the list is not scrolled to its end. */}
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 bottom-0 flex h-10 items-end justify-center bg-gradient-to-t from-ink to-transparent transition-opacity duration-150 ${
          moreBelow ? "opacity-100" : "opacity-0"
        }`}
      >
        <ChevronDown size={16} className="mb-0.5 text-paper/50" />
      </div>
    </div>
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
        data-tour="menu"
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
              className={`relative flex min-h-16 short:min-h-[52px] flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors duration-150 active:scale-95 ${
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
              <span className="short:sr-only">{item.label}</span>
            </Link>
          );
        })}

        {/* 5th Tab: More Drawer Trigger */}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-expanded={moreOpen}
          aria-label="More navigation options"
          className={`relative flex min-h-16 short:min-h-[52px] flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors duration-150 active:scale-95 ${
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
          <span className="short:sr-only">More</span>
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
