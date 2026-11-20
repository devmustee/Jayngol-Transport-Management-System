import type { Metadata } from "next";
import Link from "next/link";
import { Card, Empty, PageHeader } from "@/components/ui";
import { queryValue } from "@/lib/format";
import { can } from "@/lib/permissions";
import { requireStaffCtx } from "@/lib/session";
import { GUIDE_AREAS, searchTopics, type GuideArea } from "@/guide";

export const metadata: Metadata = { title: "Guide" };

export default async function GuidePage({ searchParams }: { searchParams: Promise<Record<string, unknown>> }) {
  const { actor } = await requireStaffCtx();
  const q = (queryValue((await searchParams).q) ?? "").trim().slice(0, 80);
  const topics = searchTopics(actor.role, q);
  const areas = (Object.keys(GUIDE_AREAS) as GuideArea[])
    .map((area) => ({ area, topics: topics.filter((topic) => topic.area === area) }))
    .filter((group) => group.topics.length > 0);

  return (
    <>
      <PageHeader
        title="Guide"
        subtitle="How to do your work in Jayngol, step by step"
        action={
          can(actor.role, "guide.progress") ? (
            <Link href="/guide/progress" className="text-sm font-semibold text-gold-deep underline">
              Tours taken
            </Link>
          ) : undefined
        }
      />
      <form className="mb-4 flex gap-2" role="search">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search, such as close cash or bank"
          aria-label="Search the Guide"
          className="min-h-11 w-full min-w-0 rounded-lg border border-line bg-card px-3 text-base"
        />
        <button className="min-h-11 shrink-0 rounded-lg bg-ink px-4 font-semibold text-gold-light">Search</button>
      </form>
      {areas.length === 0 ? (
        <Empty>{q ? `Nothing in the Guide matches “${q}”.` : "Guides for your work are coming soon."}</Empty>
      ) : (
        <div className="space-y-4">
          {areas.map(({ area, topics: list }) => (
            <Card key={area} title={GUIDE_AREAS[area]}>
              <ul className="divide-y divide-line">
                {list.map((topic) => (
                  <li key={topic.id}>
                    <Link href={`/guide/${topic.id}`} className="-mx-2 block rounded-lg px-2 py-3 hover:bg-gold-wash">
                      <span className="block font-semibold text-ink">{topic.title}</span>
                      <span className="mt-0.5 block text-sm text-muted">{topic.summary}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
          {q ? (
            <Link href="/guide" className="inline-block text-sm font-semibold text-gold-deep underline">
              Show every topic
            </Link>
          ) : null}
        </div>
      )}
    </>
  );
}
