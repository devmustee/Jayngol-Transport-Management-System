import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { requirePage } from "@/lib/session";
import { REPORTS } from "@/services/reports";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage() {
  await requirePage("finance.view");
  return (
    <>
      <PageHeader title="Reports" subtitle="View, download as CSV or save as PDF" back={{ href: "/money", label: "Money" }} />
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
        {Object.entries(REPORTS).map(([key, report]) => (
          <li key={key}>
            <Link href={`/reports/${key}`} className="flex min-h-12 items-center justify-between px-4 font-semibold hover:bg-gold-wash">
              {report.title} <span aria-hidden className="text-gold-deep">→</span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
