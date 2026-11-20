import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Empty, PageHeader } from "@/components/ui";
import { queryValue } from "@/lib/format";
import { isStaff } from "@/lib/permissions";
import { requireCtx } from "@/lib/session";
import { searchTopics } from "@/guide";

export const metadata: Metadata = { title: "Help" };

/** The operator's Guide: short answers to what operators ask the office most. */
export default async function MyGuidePage({ searchParams }: { searchParams: Promise<Record<string, unknown>> }) {
  const { actor } = await requireCtx();
  if (isStaff(actor.role)) redirect("/guide");
  const q = (queryValue((await searchParams).q) ?? "").trim().slice(0, 80);
  const topics = searchTopics(actor.role, q);

  return (
    <main className="mx-auto max-w-lg p-4 pb-[calc(env(safe-area-inset-bottom)+4rem)] sm:p-6">
      <PageHeader title="Help" subtitle="How things work at Jayngol" back={{ href: "/me", label: "My page" }} />
      <form className="mb-4 flex gap-2" role="search">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search, such as fine or PIN"
          aria-label="Search help"
          className="min-h-11 w-full min-w-0 rounded-lg border border-line bg-card px-3 text-base"
        />
        <button className="min-h-11 shrink-0 rounded-lg bg-ink px-4 font-semibold text-gold-light">Search</button>
      </form>
      {topics.length === 0 ? (
        <Empty>{q ? `Nothing matches “${q}”. Ask the office.` : "Help is coming soon."}</Empty>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-card">
          {topics.map((topic) => (
            <li key={topic.id}>
              <Link href={`/me/guide/${topic.id}`} className="block px-4 py-3 hover:bg-gold-wash">
                <span className="block font-semibold text-ink">{topic.title}</span>
                <span className="mt-0.5 block text-sm text-muted">{topic.summary}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {q ? (
        <Link href="/me/guide" className="mt-4 inline-block text-sm font-semibold text-gold-deep underline">
          Show all help
        </Link>
      ) : null}
    </main>
  );
}
