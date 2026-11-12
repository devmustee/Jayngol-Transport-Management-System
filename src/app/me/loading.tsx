import { PageSkeleton } from "@/components/page-skeleton";

export default function Loading() {
  return (
    <main className="mx-auto max-w-lg p-4 sm:p-6">
      <PageSkeleton />
    </main>
  );
}
