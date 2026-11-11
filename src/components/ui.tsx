import Link from "next/link";
import { ArrowLeft, ChevronDown, LucideIcon, Search } from "lucide-react";
import type { ReactNode } from "react";

export function PageHeader({
  title,
  subtitle,
  back,
  action,
}: {
  title: string;
  subtitle?: ReactNode;
  back?: { href: string; label: string };
  action?: ReactNode;
}) {
  return (
    <header className="mb-5 sm:mb-6">
      {back ? (
        <div className="mb-1 -ml-2.5">
          <Link
            href={back.href}
            className="group inline-flex min-h-11 items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-semibold text-gold-deep transition-all duration-150 hover:bg-gold-wash"
          >
            <ArrowLeft size={16} className="transition-transform group-hover:-translate-x-0.5" />
            <span>{back.label}</span>
          </Link>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-[1_1_16rem]">
          <h1 className="text-[1.6rem] leading-tight font-extrabold tracking-tight text-ink md:text-3xl">
            {title}
          </h1>
          {subtitle ? (
            <div className="mt-1 text-sm font-medium leading-snug text-muted md:text-base">{subtitle}</div>
          ) : null}
        </div>
        {action ? <div className="flex flex-wrap items-center gap-2">{action}</div> : null}
      </div>
    </header>
  );
}

export function Card({
  title,
  subtitle,
  children,
  action,
  className = "",
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-line bg-card p-4 shadow-premium sm:p-5 ${className}`}>
      {title ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-line/60 pb-3">
          <div className="min-w-0">
            <h2 className="text-lg font-bold leading-snug tracking-tight text-ink">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-xs leading-relaxed text-muted">{subtitle}</p> : null}
          </div>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function LinkButton({
  href,
  children,
  variant = "primary",
  className = "",
}: {
  href: string;
  children: ReactNode;
  variant?: "primary" | "gold" | "secondary" | "danger" | "quiet";
  className?: string;
}) {
  const base =
    "inline-flex min-h-12 items-center justify-center gap-2 rounded-xl px-5 py-2.5 font-semibold text-sm transition-all duration-150 active:scale-[0.98] select-none";

  const variants = {
    primary:
      "bg-ink text-gold-light hover:bg-ink-soft hover:shadow-md border border-ink-muted/40",
    gold:
      "bg-gradient-to-r from-gold to-gold-light text-ink shadow-gold-sm hover:brightness-105 font-bold",
    secondary:
      "bg-card border border-line-strong text-ink hover:bg-gold-wash hover:border-gold-deep/50",
    danger:
      "bg-danger-wash text-danger border border-danger-border hover:bg-danger/10",
    quiet:
      "bg-transparent text-ink hover:bg-line/40 hover:text-gold-deep",
  };

  return (
    <Link href={href} className={`${base} ${variants[variant]} ${className}`}>
      {children}
    </Link>
  );
}

const TONES = {
  good: "bg-ok-wash text-ok border-ok-border",
  gold: "bg-gold-wash text-gold-deep border-gold-light/60",
  bad: "bg-danger-wash text-danger border-danger-border",
  plain: "bg-line/40 text-muted border-line",
  warning: "bg-warning-wash text-warning border-warning-border",
  info: "bg-info-wash text-info border-info-border",
} as const;

export function Badge({
  tone,
  children,
  dot = false,
}: {
  tone: keyof typeof TONES;
  children: ReactNode;
  dot?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-bold tracking-wide whitespace-nowrap uppercase ${TONES[tone]}`}
    >
      {dot ? (
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            tone === "good"
              ? "bg-ok"
              : tone === "bad"
              ? "bg-danger"
              : tone === "gold" || tone === "warning"
              ? "bg-gold-deep"
              : "bg-muted"
          }`}
          aria-hidden
        />
      ) : null}
      {children}
    </span>
  );
}

export const tricycleTone = (status: string): keyof typeof TONES =>
  status === "issued" ? "good" : status === "in_stock" ? "gold" : status === "off_road" ? "bad" : "plain";

export const operatorTone = (status: string): keyof typeof TONES =>
  status === "active" ? "good" : status === "sacked" ? "bad" : "plain";

export function StatTile({
  label,
  value,
  href,
  icon: Icon,
  tone = "plain",
  subtext,
}: {
  label: string;
  value: number | string;
  href: string;
  icon?: LucideIcon;
  tone?: "good" | "bad" | "warning" | "gold" | "plain" | "info";
  subtext?: string;
}) {
  const iconTones = {
    good: "bg-ok-wash text-ok border-ok-border/60",
    bad: "bg-danger-wash text-danger border-danger-border/60",
    warning: "bg-warning-wash text-warning border-warning-border/60",
    gold: "bg-gold-wash text-gold-deep border-gold-light/60",
    plain: "bg-line/40 text-muted border-line",
    info: "bg-info-wash text-info border-info-border/60",
  };

  return (
    <Link
      href={href}
      className="group relative flex flex-col justify-between overflow-hidden rounded-2xl border border-line bg-card p-4.5 shadow-premium transition-all duration-200 hover:-translate-y-0.5 hover:border-gold hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-semibold text-muted transition-colors group-hover:text-ink">
          {label}
        </span>
        {Icon ? (
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${iconTones[tone]} transition-transform duration-200 group-hover:scale-110`}
          >
            <Icon size={18} aria-hidden />
          </div>
        ) : null}
      </div>

      <div className="mt-3">
        <div className="text-3xl font-extrabold tracking-tight tabular-nums text-ink md:text-4xl">
          {value}
        </div>
        {subtext ? <div className="mt-1 text-xs font-medium text-muted">{subtext}</div> : null}
      </div>

      <div className="mt-3 hidden items-center gap-1 text-xs font-bold text-gold-deep opacity-0 transition-opacity duration-150 group-hover:opacity-100 md:flex">
        <span>View details</span>
        <span aria-hidden>→</span>
      </div>
    </Link>
  );
}

export function Details({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="divide-y divide-line/70 rounded-xl border border-line/60 bg-card-subtle/50 px-4">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-4 py-3">
          <dt className="shrink-0 text-sm font-medium text-muted">{label}</dt>
          <dd className="min-w-0 text-right text-sm font-semibold text-ink [overflow-wrap:anywhere]">{value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Empty({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-line bg-card/60 px-5 py-8 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gold-wash text-gold-deep mb-3">
        <Search size={22} />
      </div>
      <p className="max-w-md text-sm font-medium text-muted">{children}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/** A form tucked behind a heading, so long pages stay short on a phone. */
export function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="group rounded-2xl border border-line bg-card shadow-premium transition-colors">
      <summary className="flex min-h-12 items-center justify-between gap-3 rounded-2xl px-4 py-3 font-bold text-ink transition-colors hover:bg-gold-wash/50 group-open:rounded-b-none sm:px-5">
        <span className="min-w-0">{label}</span>
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-line/50 text-gold-deep transition-transform duration-200 group-open:rotate-180">
          <ChevronDown size={18} aria-hidden />
        </div>
      </summary>
      <div className="border-t border-line/70 p-4 sm:p-5">{children}</div>
    </details>
  );
}

export function SearchBar({
  q,
  status,
  placeholder,
  options,
}: {
  q?: string;
  status?: string;
  placeholder: string;
  options: Record<string, string>;
}) {
  const control =
    "min-h-12 rounded-xl border border-line bg-card px-3.5 py-2.5 text-base text-ink placeholder:text-muted/60 transition-colors focus:border-gold";
  return (
    <form className="mb-5 flex flex-wrap gap-2.5" role="search">
      <div className="relative min-w-0 flex-[2_1_14rem]">
        <input
          name="q"
          defaultValue={q}
          placeholder={placeholder}
          aria-label={placeholder}
          className={`${control} w-full pl-10`}
        />
        <Search
          size={18}
          className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"
          aria-hidden
        />
      </div>
      <select
        name="status"
        defaultValue={status ?? ""}
        aria-label="Status"
        className={`${control} flex-[1_1_9rem] cursor-pointer`}
      >
        <option value="">All statuses</option>
        {Object.entries(options).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <button className="inline-flex min-h-12 items-center justify-center rounded-xl bg-ink px-5 font-bold text-sm text-gold-light transition-all hover:bg-ink-soft active:scale-[0.98]">
        Search
      </button>
    </form>
  );
}
