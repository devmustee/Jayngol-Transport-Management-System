import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  attendanceAction,
  cancelMeetingAction,
  closeMeetingAction,
  markAbsentAction,
} from "@/app/actions";
import { ActionForm, SubmitButton, TextareaField } from "@/components/form";
import { Badge, Card, Disclosure, Empty, PageHeader } from "@/components/ui";
import { isUuid } from "@/lib/fields";
import { ATTENDANCE_LABELS, formatDateTime, MEETING_STATUS_LABELS } from "@/lib/format";
import { can } from "@/lib/permissions";
import { requirePage } from "@/lib/session";
import { getMeeting } from "@/services/meetings";

export const metadata: Metadata = { title: "Meeting" };

const MARKS = ["present_with_tricycle", "present_without_tricycle", "absent"] as const;

export default async function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePage("meeting.view");
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const detail = await getMeeting(ctx, id);
  if (!detail) notFound();
  const { meeting, roster, canTakeAttendance } = detail;

  const open = meeting.status === "scheduled";
  const canMark = open && canTakeAttendance && can(ctx.actor.role, "meeting.attendance");
  const canExcuse = open && can(ctx.actor.role, "meeting.excuse");
  const unmarked = roster.filter((person) => !person.status).length;

  return (
    <>
      <PageHeader
        title={meeting.title}
        subtitle={`${formatDateTime(meeting.scheduledFor)} · ${MEETING_STATUS_LABELS[meeting.status]}`}
        back={{ href: "/meetings", label: "Meetings" }}
      />
      <div className="space-y-4">
        {open && !canTakeAttendance ? <Empty>Attendance opens on the day of the meeting.</Empty> : null}
        {roster.length === 0 ? (
          <Empty>No operators are expected.</Empty>
        ) : (
          <ul className="space-y-3">
            {roster.map((person) => (
              <li key={person.operatorId}>
                <Card>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-bold">{person.name}</div>
                      <div className="text-sm text-muted">
                        {person.code}
                        {person.offRoad ? " · Off road, so no tricycle is needed" : ""}
                      </div>
                      {person.reason ? <div className="mt-1 text-sm">{person.reason}</div> : null}
                    </div>
                    {person.status ? (
                      <Badge tone={person.status === "absent" || person.status === "present_without_tricycle" ? "bad" : "good"}>
                        {ATTENDANCE_LABELS[person.status]}
                      </Badge>
                    ) : null}
                  </div>
                  {canMark ? (
                    <div className="mt-3 grid grid-cols-3 gap-2">
                      {MARKS.map((status) => (
                        <ActionForm key={status} action={attendanceAction.bind(null, meeting.id)} className="">
                          <input type="hidden" name="operatorId" value={person.operatorId} />
                          <input type="hidden" name="status" value={status} />
                          <button
                            aria-pressed={person.status === status}
                            className="min-h-12 w-full rounded-lg border border-line bg-card px-1 text-sm font-semibold aria-pressed:bg-ink aria-pressed:text-gold-light"
                          >
                            {ATTENDANCE_LABELS[status]}
                          </button>
                        </ActionForm>
                      ))}
                    </div>
                  ) : null}
                  {canExcuse ? (
                    <div className="mt-3">
                      <Disclosure label="Excuse">
                        <ActionForm action={attendanceAction.bind(null, meeting.id)}>
                          <input type="hidden" name="operatorId" value={person.operatorId} />
                          <input type="hidden" name="status" value="excused" />
                          <TextareaField name="reason" label="Reason" />
                          <SubmitButton tone="plain">Excuse, no fine</SubmitButton>
                        </ActionForm>
                      </Disclosure>
                    </div>
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>
        )}
        {canMark ? (
          <Card title="Finish">
            <div className="space-y-3">
              {unmarked > 0 ? (
                <>
                  <p className="text-muted">{unmarked} operator(s) are not marked yet.</p>
                  <Disclosure label="Mark the rest absent">
                    <ActionForm action={markAbsentAction.bind(null, meeting.id)}>
                      <p className="text-sm">Each of them will be reported for a ₦6,000 absence when the meeting closes.</p>
                      <SubmitButton tone="plain">Mark {unmarked} absent</SubmitButton>
                    </ActionForm>
                  </Disclosure>
                </>
              ) : null}
              <ActionForm action={closeMeetingAction.bind(null, meeting.id)}>
                <p className="text-sm text-muted">
                  Closing reports the offences for confirmation. Attendance cannot change after this.
                </p>
                <SubmitButton>Close meeting</SubmitButton>
              </ActionForm>
            </div>
          </Card>
        ) : null}
        {open && can(ctx.actor.role, "meeting.schedule") ? (
          <Disclosure label="Cancel meeting">
            <ActionForm action={cancelMeetingAction.bind(null, meeting.id)}>
              <TextareaField name="reason" label="Reason" />
              <SubmitButton tone="plain">Cancel meeting</SubmitButton>
            </ActionForm>
          </Disclosure>
        ) : null}
      </div>
    </>
  );
}
