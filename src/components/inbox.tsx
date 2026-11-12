import Link from "next/link";
import { AlertTriangle, Bell, BellRing, ChevronRight, Info } from "lucide-react";
import { markAllNotificationsReadAction, openNotificationAction } from "@/app/actions";
import { ActionForm, SubmitButton } from "@/components/form";
import { formatDateTime } from "@/lib/format";
import type { InboxItem } from "@/services/notifications";

const SEVERITY = {
  critical: { icon: AlertTriangle, label: "Urgent", style: "text-danger" },
  action: { icon: BellRing, label: "Needs you", style: "text-gold-deep" },
  info: { icon: Info, label: "Update", style: "text-info" },
} as const;

function Item({ item }: { item: InboxItem }) {
  const severity = SEVERITY[item.severity];
  const Icon = item.readAt ? Bell : severity.icon;
  const unread = !item.readAt;
  return (
    <li>
      <form action={openNotificationAction.bind(null, item.id)}>
        <button
          type="submit"
          className={`flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-gold-wash/50 ${
            unread ? "bg-gold-wash/30" : ""
          }`}
        >
          <Icon size={18} aria-hidden className={`mt-0.5 shrink-0 ${item.readAt ? "text-muted" : severity.style}`} />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span className={`text-sm ${unread ? "font-semibold text-ink" : "font-semibold text-ink-muted"}`}>{item.title}</span>
              {unread ? <span className={`text-xs font-medium ${severity.style}`}>{severity.label}</span> : null}
            </span>
            <span className={`mt-0.5 block text-sm leading-snug ${unread ? "text-ink" : "text-ink-muted"}`}>{item.body}</span>
            <span className="mt-1 block text-xs text-muted">{formatDateTime(item.createdAt)}</span>
          </span>
          {item.link ? <ChevronRight size={16} aria-hidden className="mt-1 shrink-0 text-muted/70" /> : null}
          {unread ? <span className="sr-only">(new)</span> : null}
        </button>
      </form>
    </li>
  );
}

/** One person's notifications: newest first, with a filter, paging and "mark all as read". */
export function Inbox({
  items,
  page,
  hasMore,
  unread,
  unreadOnly,
  basePath,
}: {
  items: InboxItem[];
  page: number;
  hasMore: boolean;
  unread: number;
  unreadOnly: boolean;
  basePath: string;
}) {
  const href = (next: { show?: "unread"; page?: number }) => {
    const query = new URLSearchParams();
    if (next.show) query.set("show", next.show);
    if (next.page && next.page > 1) query.set("page", String(next.page));
    const text = query.toString();
    return text ? `${basePath}?${text}` : basePath;
  };
  const tab = (active: boolean) =>
    `inline-flex min-h-11 items-center rounded-xl px-4 text-sm font-bold transition-colors ${
      active ? "bg-ink text-gold-light" : "border border-line bg-card text-ink hover:bg-gold-wash"
    }`;
  const show = unreadOnly ? ("unread" as const) : undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Show" className="flex gap-2">
          <Link href={href({})} className={tab(!unreadOnly)} aria-current={!unreadOnly ? "page" : undefined}>
            All
          </Link>
          <Link href={href({ show: "unread" })} className={tab(unreadOnly)} aria-current={unreadOnly ? "page" : undefined}>
            New{unread > 0 ? ` (${unread})` : ""}
          </Link>
        </nav>
        {unread > 0 ? (
          <ActionForm action={markAllNotificationsReadAction}>
            <SubmitButton tone="plain">Mark all as read</SubmitButton>
          </ActionForm>
        ) : null}
      </div>

      <section className="rounded-2xl border border-line bg-card p-2 shadow-premium sm:p-3">
        {items.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-muted">
            {unreadOnly ? "Nothing new. You are up to date." : page > 1 ? "No older notifications." : "Nothing here yet. Messages from Jayngol will appear here."}
          </p>
        ) : (
          <ul className="space-y-1">
            {items.map((item) => (
              <Item key={item.id} item={item} />
            ))}
          </ul>
        )}
      </section>

      {page > 1 || hasMore ? (
        <nav aria-label="Pages" className="flex justify-between gap-3">
          {page > 1 ? (
            <Link href={href({ show, page: page - 1 })} className={tab(false)}>
              Newer
            </Link>
          ) : (
            <span />
          )}
          {hasMore ? (
            <Link href={href({ show, page: page + 1 })} className={tab(false)}>
              Older
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}

export const parseInboxQuery = (query: { show?: string; page?: string }) => ({
  unreadOnly: query.show === "unread",
  page: Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1),
});
