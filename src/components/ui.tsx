import Link from "next/link";
import { ArrowLeft, ChevronDown, Inbox, LucideIcon, Search } from "lucide-react";
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
          <h1 className="text-2xl leading-tight font-bold tracking-tight text-ink md:text-[1.75rem]">
            {title}
          </h1>
          {subtitle ? (
            <div className="mt-1 text-sm leading-snug text-muted">{subtitle}</div>
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
    <section className={`rounded-2xl border border-line bg-card p-4 sm:p-5 ${className}`}>
      {title ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-base font-semibold leading-snug text-ink">{title}</h2>
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
    "inline-flex min-h-12 items-center justify-center gap-2 rounded-xl px-5 py-2.5 font-semibold text-sm transition-colors duration-150 active:scale-[0.98] select-none";

  const variants = {
    primary:
      "bg-ink text-paper hover:bg-ink-soft",
    gold:
      "bg-gold text-ink hover:bg-gold-light",
    secondary:
      "bg-card border border-line text-ink hover:border-line-strong hover:bg-card-subtle",
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
  good: "bg-ok-wash text-ok",
  gold: "bg-gold-wash text-gold-deep",
  bad: "bg-danger-wash text-danger",
  plain: "bg-line/40 text-muted",
  warning: "bg-warning-wash text-warning",
  info: "bg-info-wash text-info",
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
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${TONES[tone]}`}
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
    good: "text-ok",
    bad: "text-danger",
    warning: "text-warning",
    gold: "text-gold-deep",
    plain: "text-muted",
    info: "text-info",
  };

  return (
    <Link
      href={href}
      className="group relative flex flex-col justify-between overflow-hidden rounded-2xl border border-line bg-card p-4.5 transition-colors duration-150 hover:border-line-strong active:scale-[0.99]"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm text-muted">
          {label}
        </span>
        {Icon ? (
          <Icon size={18} aria-hidden className={`shrink-0 ${iconTones[tone]}`} />
        ) : null}
      </div>

      <div className="mt-3">
        <div className="text-3xl font-semibold tracking-tight tabular-nums text-ink">
          {value}
        </div>
        {subtext ? <div className="mt-1 text-xs text-muted">{subtext}</div> : null}
      </div>
    </Link>
  );
}

export function Details({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="divide-y divide-line/70">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-4 py-3 first:pt-1 last:pb-1">
          <dt className="shrink-0 text-sm text-muted">{label}</dt>
          <dd className="min-w-0 text-right text-sm font-medium text-ink [overflow-wrap:anywhere]">{value ?? "—"}</dd>
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
    <div className="flex flex-col items-center justify-center rounded-2xl border border-line bg-card px-5 py-10 text-center">
      <Inbox size={22} className="mb-2 text-muted/70" aria-hidden />
      <p className="max-w-md text-sm text-muted">{children}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/** A form tucked behind a heading, so long pages stay short on a phone. */
export function Disclosure({ label, children, open }: { label: string; children: ReactNode; open?: boolean }) {
  return (
    <details className="group rounded-2xl border border-line bg-card" open={open}>
      <summary className="flex min-h-12 items-center justify-between gap-3 rounded-2xl px-4 py-3 font-semibold text-ink transition-colors hover:bg-card-subtle group-open:rounded-b-none sm:px-5">
        <span className="min-w-0">{label}</span>
        <ChevronDown size={18} aria-hidden className="shrink-0 text-muted transition-transform duration-200 group-open:rotate-180" />
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
      <button className="inline-flex min-h-12 items-center justify-center rounded-xl bg-ink px-5 font-semibold text-sm text-paper transition-colors hover:bg-ink-soft active:scale-[0.98]">
        Search
      </button>
    </form>
  );
}
