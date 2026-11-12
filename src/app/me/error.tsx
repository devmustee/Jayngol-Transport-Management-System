"use client";

import { ErrorPanel } from "@/components/error-panel";

export default function PortalError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto max-w-lg p-4 sm:p-6">
      <ErrorPanel {...props} home="/me" />
    </main>
  );
}
