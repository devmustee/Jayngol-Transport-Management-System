import type { Metadata } from "next";
import { NotFoundPanel } from "@/components/not-found-panel";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <main className="mx-auto max-w-lg p-4 sm:p-6">
      <NotFoundPanel home="/" />
    </main>
  );
}
