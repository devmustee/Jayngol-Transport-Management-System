import type { Metadata } from "next";
import Link from "next/link";
import { scheduleMeetingAction } from "@/app/actions";
import { ActionForm, Field, SubmitButton } from "@/components/form";
import { Badge, Card, Disclosure, Empty, PageHeader } from "@/components/ui";
import { formatDateTime, MEETING_STATUS_LABELS } from "@/lib/format";
import { can } from "@/lib/permissions";
import { requirePage } from "@/lib/session";
import { listMeetings } from "@/services/meetings";

export const metadata: Metadata = { title: "Meetings" };

const TONE = { scheduled: "gold", closed: "good", cancelled: "plain" } as const;

export default async function MeetingsPage() {
  const ctx = await requirePage("meeting.view");
  const meetings = await listMeetings(ctx);
  return (
    <>
      <PageHeader title="General meetings" />
      <div className="space-y-4">
        {can(ctx.actor.role, "meeting.schedule") ? (
          <Disclosure label="Schedule a meeting">
            <ActionForm action={scheduleMeetingAction}>
              <Field name="title" label="Title" />
              <Field name="scheduledFor" label="Date and time" type="datetime-local" />
              <SubmitButton>Schedule and notify operators</SubmitButton>
            </ActionForm>
          </Disclosure>
        ) : null}
        {meetings.length === 0 ? (
          <Empty>No meetings yet.</Empty>
        ) : (
          <ul className="space-y-3">
            {meetings.map((meeting) => (
              <li key={meeting.id}>
                <Link href={`/meetings/${meeting.id}`} className="block">
                  <Card>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-bold">{meeting.title}</div>
                        <div className="text-sm text-muted">{formatDateTime(meeting.scheduledFor)}</div>
                      </div>
                      <Badge tone={TONE[meeting.status]}>{MEETING_STATUS_LABELS[meeting.status]}</Badge>
                    </div>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
