import { PageSkeleton } from "@/components/page-skeleton";

// Shown inside the menu frame the moment a page is opened, and lets Next.js
// fetch each page's frame ahead of time.
export default function Loading() {
  return <PageSkeleton />;
}
