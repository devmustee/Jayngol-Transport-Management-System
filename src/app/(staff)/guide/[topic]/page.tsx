import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Footprints } from "lucide-react";
import { Card, PageHeader } from "@/components/ui";
import { requireStaffCtx } from "@/lib/session";
import { topicFor, tourForTopic } from "@/guide";

export const metadata: Metadata = { title: "Guide" };

export default async function GuideTopicPage({ params }: { params: Promise<{ topic: string }> }) {
  const { actor } = await requireStaffCtx();
  const topic = topicFor(actor.role, (await params).topic);
  if (!topic) notFound();
  const tour = tourForTopic(actor.role, topic.id);
  const related = (topic.related ?? []).map((id) => topicFor(actor.role, id)).filter((t) => t !== null);

  return (
    <>
      <PageHeader title={topic.title} back={{ href: "/guide", label: "Guide" }} />
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
        {topic.links?.length || tour ? (
          <div className="flex flex-wrap gap-2">
            {tour ? (
              <Link
                href={`${tour.page}?tour=${tour.id}`}
                className="flex min-h-11 items-center gap-2 rounded-xl border border-gold-light/60 bg-gold-wash/50 px-4 font-semibold text-gold-deep"
              >
                <Footprints size={18} aria-hidden /> Show me on the page
              </Link>
            ) : null}
            {(topic.links ?? []).map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="flex min-h-11 items-center rounded-xl bg-ink px-4 font-semibold text-gold-light"
              >
                {link.label} <span aria-hidden className="ml-2">→</span>
              </Link>
            ))}
          </div>
        ) : null}
        {related.length ? (
          <Card title="Related">
            <ul className="divide-y divide-line">
              {related.map((other) => (
                <li key={other.id}>
                  <Link href={`/guide/${other.id}`} className="-mx-2 block rounded-lg px-2 py-2.5 font-semibold text-gold-deep hover:bg-gold-wash">
                    {other.title}
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </div>
    </>
  );
}
