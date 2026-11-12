"use client";

import Link from "next/link";
import { Bell } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type BellSummary = { unread: number; critical: number };

const EVERY_MINUTE = 60_000;

/**
 * The bell with its unread count. It asks the server again every minute while
 * the page is on screen, and straight away when the person comes back to it.
 */
export function NotificationBell({
  href,
  initial,
  variant = "dark",
  label = false,
}: {
  href: string;
  initial: BellSummary;
  /** "dark" sits on the black header and sidebar, "light" on a white card. */
  variant?: "dark" | "light";
  /** Show the word "Notifications" beside the bell, as in the sidebar. */
  label?: boolean;
}) {
  const [summary, setSummary] = useState(initial);

  // A new page from the server brings a fresh count.
  useEffect(() => setSummary(initial), [initial.unread, initial.critical]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let stopped = false;
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const response = await fetch("/api/notifications", { cache: "no-cache" });
        if (!response.ok || stopped) return;
        const next = (await response.json()) as BellSummary;
        if (!stopped) setSummary({ unread: next.unread, critical: next.critical });
      } catch {
        // Offline or a weak signal: keep the last count and try again next minute.
      }
    };
    const timer = window.setInterval(check, EVERY_MINUTE);
    const onShow = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onShow);
    window.addEventListener("online", onShow);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onShow);
      window.removeEventListener("online", onShow);
    };
  }, []);

  const { unread, critical } = summary;

  // When a new notification arrives while the page is open, the bell rocks once.
  const lastUnread = useRef(initial.unread);
  const [ring, setRing] = useState(0);
  useEffect(() => {
    if (unread > lastUnread.current) setRing((n) => n + 1);
    lastUnread.current = unread;
  }, [unread]);
  const count = unread > 99 ? "99+" : String(unread);
  const name = unread === 0 ? "Notifications, none new" : `Notifications, ${unread} new${critical > 0 ? `, ${critical} urgent` : ""}`;
  const base =
    variant === "dark"
      ? "text-gold-light hover:bg-ink-soft border-gold/30 bg-ink-soft"
      : "text-ink hover:bg-gold-wash border-line bg-card-subtle";

  return (
    <Link
      href={href}
      aria-label={name}
      className={`relative inline-flex min-h-11 min-w-11 items-center justify-center gap-2.5 rounded-xl border px-2.5 transition-colors active:scale-95 ${base} ${
        label ? "w-full justify-start px-3 text-sm font-semibold" : ""
      }`}
    >
      <Bell key={`bell-${ring}`} size={label ? 18 : 20} aria-hidden className={ring > 0 ? "origin-top animate-bell" : ""} />
      {label ? <span className="flex-1">Notifications</span> : null}
      {unread > 0 ? (
        <span
          key={`count-${ring}`}
          aria-hidden
          className={`${ring > 0 ? "animate-pop" : ""} ${label ? "" : "absolute -right-1.5 -top-1.5"} inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-black leading-5 tabular-nums ${
            critical > 0 ? "bg-danger text-white" : "bg-gold text-ink"
          }`}
        >
          {count}
        </span>
      ) : null}
    </Link>
  );
}
