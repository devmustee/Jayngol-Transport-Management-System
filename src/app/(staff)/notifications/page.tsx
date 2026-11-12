import type { Metadata } from "next";
import { Inbox, parseInboxQuery } from "@/components/inbox";
import { PageHeader } from "@/components/ui";
import { requireStaffCtx } from "@/lib/session";
import { inboxSummary, myInbox } from "@/services/notifications";

export const metadata: Metadata = { title: "Notifications" };

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<{ show?: string; page?: string }> }) {
  const ctx = await requireStaffCtx();
  const { unreadOnly, page } = parseInboxQuery(await searchParams);
  const [inbox, summary] = await Promise.all([myInbox(ctx, { unreadOnly, page }), inboxSummary(ctx)]);
  return (
    <>
      <PageHeader title="Notifications" subtitle="Updates for you, newest first. Tap one to open it." />
      <Inbox {...inbox} unread={summary.unread} unreadOnly={unreadOnly} basePath="/notifications" />
    </>
  );
}
