import type { Metadata } from "next";
import { Inbox, parseInboxQuery } from "@/components/inbox";
import { PageHeader } from "@/components/ui";
import { requireStaffCtx } from "@/lib/session";
import { needsAction } from "@/services/needs-action";
import { inboxSummary, myInbox } from "@/services/notifications";

export const metadata: Metadata = { title: "Notifications" };

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<{ show?: string; page?: string }> }) {
  const ctx = await requireStaffCtx();
  const { unreadOnly, show, page } = parseInboxQuery(await searchParams);
  const [inbox, summary, actions] = await Promise.all([myInbox(ctx, { unreadOnly, page }), inboxSummary(ctx), needsAction(ctx)]);
  const showActions = show === "actions" || (!show && !unreadOnly && actions.length > 0);
  return (
    <>
      <PageHeader title="Notifications" subtitle="Work waiting for you, and updates, newest first. Tap one to open it." />
      <Inbox
        {...inbox}
        unread={summary.unread}
        unreadOnly={unreadOnly}
        basePath="/notifications"
        actions={actions}
        showActions={showActions}
      />
    </>
  );
}
