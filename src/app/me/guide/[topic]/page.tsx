import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Card, PageHeader } from "@/components/ui";
import { isStaff } from "@/lib/permissions";
import { requireCtx } from "@/lib/session";
import { topicFor } from "@/guide";

export const metadata: Metadata = { title: "Help" };

export default async function MyGuideTopicPage({ params }: { params: Promise<{ topic: string }> }) {
  const { actor } = await requireCtx();
  const id = (await params).topic;
  if (isStaff(actor.role)) redirect(`/guide/${encodeURIComponent(id)}`);
  const topic = topicFor(actor.role, id);
  if (!topic) notFound();
  const related = (topic.related ?? []).map((other) => topicFor(actor.role, other)).filter((t) => t !== null);

  return (
    <main className="mx-auto max-w-lg p-4 pb-[calc(env(safe-area-inset-bottom)+4rem)] sm:p-6">
      <PageHeader title={topic.title} back={{ href: "/me/guide", label: "Help" }} />
      <div className="space-y-4">
        <p className="text-base leading-relaxed text-ink">{topic.summary}</p>
        {topic.steps?.length ? (
          <Card title="What to do">
            <ol className="space-y-3">
              {topic.steps.map((step, index) => (
                <li key={step} className="flex gap-3">
                  <span
                    aria-hidden
                    className="flex size-7 shrink-0 items-center justify-center rounded-full bg-gold-wash text-sm font-bold text-gold-deep"
                  >
                    {index + 1}
                  </span>
                  <span className="pt-0.5">{step}</span>
                </li>
              ))}
            </ol>
          </Card>
        ) : null}
        {topic.goodToKnow?.length ? (
          <Card title="Good to know">
            <ul className="list-disc space-y-2 pl-5 marker:text-gold-deep">
              {topic.goodToKnow.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </Card>
        ) : null}
        {related.length ? (
          <Card title="Also asked">
            <ul className="divide-y divide-line">
              {related.map((other) => (
                <li key={other.id}>
                  <Link href={`/me/guide/${other.id}`} className="-mx-2 block rounded-lg px-2 py-2.5 font-semibold text-gold-deep hover:bg-gold-wash">
                    {other.title}
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
        <Link href="/me" className="flex min-h-11 items-center justify-center rounded-xl bg-ink px-4 font-semibold text-gold-light">
          Back to my page
        </Link>
      </div>
    </main>
  );
}
