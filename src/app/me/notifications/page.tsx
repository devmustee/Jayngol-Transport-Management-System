import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Inbox, parseInboxQuery } from "@/components/inbox";
import { isStaff } from "@/lib/permissions";
import { requireCtx } from "@/lib/session";
import { inboxSummary, myInbox } from "@/services/notifications";

export const metadata: Metadata = { title: "Notices" };

export default async function MyNotificationsPage({ searchParams }: { searchParams: Promise<{ show?: string; page?: string }> }) {
  const ctx = await requireCtx();
  if (isStaff(ctx.actor.role)) redirect("/notifications");
  const { unreadOnly, page } = parseInboxQuery(await searchParams);
  const [inbox, summary] = await Promise.all([myInbox(ctx, { unreadOnly, page }), inboxSummary(ctx)]);
  return (
    <main className="mx-auto max-w-lg p-4 pb-[calc(env(safe-area-inset-bottom)+4rem)] sm:p-6">
      <Link href="/me" className="-ml-2.5 mb-1 inline-flex min-h-11 items-center gap-1.5 rounded-full px-2.5 text-sm font-semibold text-gold-deep hover:bg-gold-wash">
        <ArrowLeft size={16} aria-hidden />
        My records
      </Link>
      <h1 className="mb-4 text-[1.6rem] font-semibold leading-tight tracking-tight text-ink">Notices</h1>
      <Inbox {...inbox} unread={summary.unread} unreadOnly={unreadOnly} basePath="/me/notifications" />
    </main>
  );
}
