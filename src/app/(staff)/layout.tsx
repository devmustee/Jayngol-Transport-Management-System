import Link from "next/link";
import { BottomNav, SideNav, type NavItem } from "@/components/nav";
import { can, ROLE_LABELS } from "@/lib/permissions";
import { requireStaffCtx } from "@/lib/session";

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const { actor } = await requireStaffCtx();
  const items: NavItem[] = [
    { href: "/dashboard", label: "Home", icon: "home", primary: true },
    { href: "/tricycles", label: "Tricycles", icon: "tricycles", primary: true },
    { href: "/operators", label: "Operators", icon: "operators", primary: true },
  ];
  if (can(actor.role, "finance.view")) {
    items.push({ href: "/money", label: "Money", icon: "money", primary: true });
  }
  if (can(actor.role, "inspection.record")) {
    // Supervisors have no Money tab, so this takes that place on the phone.
    const primary = !can(actor.role, "finance.view");
    items.push({ href: "/inspections", label: "Inspect", icon: "inspect", primary });
  }
  if (can(actor.role, "workorder.view")) {
    items.push({ href: "/workshop", label: "Workshop", icon: "workshop", primary: false });
  }
  if (can(actor.role, "stock.view")) {
    items.push({ href: "/store", label: "Store", icon: "store", primary: false });
  }
  if (can(actor.role, "violation.view")) {
    items.push({ href: "/offences", label: "Offences", icon: "offences", primary: false });
  }
  if (can(actor.role, "meeting.view")) {
    items.push({ href: "/meetings", label: "Meetings", icon: "meetings", primary: false });
  }
  if (can(actor.role, "inspection.report")) {
    items.push({ href: "/inspections/report", label: "Inspection report", icon: "audit", primary: false });
  }
  if (can(actor.role, "violation.view")) {
    items.push({ href: "/rules", label: "Rules and fines", icon: "rules", primary: false });
  }
  if (can(actor.role, "finance.view")) {
    items.push({ href: "/reports", label: "Reports", icon: "reports", primary: false });
  }
  if (can(actor.role, "awards.track")) {
    items.push({ href: "/awards", label: "Awards", icon: "awards", primary: false });
  }
  if (can(actor.role, "user.manage")) {
    items.push({ href: "/users", label: "Staff", icon: "staff", primary: false });
  }
  if (can(actor.role, "audit.view")) {
    items.push({ href: "/audit", label: "Audit log", icon: "audit", primary: false });
  }
  items.push({ href: "/account", label: "Account", icon: "account", primary: true });

  const roleLabel = ROLE_LABELS[actor.role] ?? actor.role;

  return (
    <div className="min-h-dvh md:flex bg-paper">
      {/* Desktop Executive Sidebar */}
      <aside className="print:hidden sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-gold-deep/20 bg-ink p-5 md:flex shadow-2xl">
        <Link href="/dashboard" className="flex items-center gap-3 group">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/jayngol-mark.svg"
            alt="Jayngol Logo"
            width={44}
            height={44}
            className="transition-transform group-hover:scale-105"
          />
          <div className="font-extrabold leading-tight tracking-tight text-gold-light">
            Jayngol
            <div className="text-[11px] font-semibold text-paper/60 uppercase tracking-wider">
              Transport Fleet
            </div>
          </div>
        </Link>

        <SideNav items={items} />

        {/* User Profile Pill at Sidebar Bottom */}
        <div className="mt-auto pt-4 border-t border-paper/10">
          <Link
            href="/account"
            className="flex items-center gap-3 rounded-xl p-2 transition-colors hover:bg-ink-soft group"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gold-wash/15 border border-gold/40 text-gold-light font-bold text-sm">
              {actor.name.charAt(0)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold text-paper truncate group-hover:text-gold-light">
                {actor.name}
              </div>
              <div className="inline-block rounded-full bg-gold/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-gold-light">
                {roleLabel}
              </div>
            </div>
          </Link>
        </div>
      </aside>

      {/* Main Workspace Area */}
      <div className="min-w-0 flex-1 flex flex-col">
        {/* Mobile Header */}
        <header className="sticky top-0 z-20 flex min-h-16 items-center justify-between border-b border-gold-deep/20 bg-ink/95 backdrop-blur-md px-4 py-2 md:hidden print:hidden shadow-md">
          <Link href="/dashboard" className="flex items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/jayngol-mark.svg" alt="Jayngol Logo" width={34} height={34} />
            <div className="flex flex-col">
              <span className="font-black text-gold-light text-base leading-tight">Jayngol</span>
              <span className="text-[10px] font-bold text-paper/60 uppercase tracking-widest leading-none">
                Fleet Ops
              </span>
            </div>
          </Link>

          <Link
            href="/account"
            aria-label={`Account: ${actor.name}`}
            className="flex min-h-10 max-w-[45vw] items-center gap-2 rounded-full border border-gold/30 bg-ink-soft px-3.5 text-xs font-bold text-gold-light active:scale-95 transition-transform"
          >
            <span className="truncate">{actor.name.split(" ")[0]}</span>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok" aria-hidden />
          </Link>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 p-4 sm:p-6 md:p-8 pb-28 md:pb-12">
          {children}
        </main>
      </div>

      <BottomNav items={items} />
    </div>
  );
}
