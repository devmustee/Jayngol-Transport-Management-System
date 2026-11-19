import { AlertTriangle, ChevronRight } from "lucide-react";
import { openNotificationAction } from "@/app/actions";

/** The newest unread urgent notice. Tapping it opens the notice, which marks it read. */
export function UrgentBanner({ notice, more }: { notice: { id: string; title: string; body: string }; more: number }) {
  return (
    <form action={openNotificationAction.bind(null, notice.id)} className="print:hidden">
      <button
        type="submit"
        className="flex w-full items-center gap-3 border-b border-danger-border bg-danger-wash px-4 py-2.5 text-left text-danger hover:bg-danger-wash/80 sm:px-6 md:px-8"
      >
        <AlertTriangle size={18} aria-hidden className="shrink-0" />
        <span className="min-w-0 flex-1 text-sm leading-snug short:truncate">
          <span className="font-bold">{notice.title}.</span> <span className="text-ink">{notice.body}</span>
          {more > 0 ? <span className="text-ink-muted"> And {more} more urgent.</span> : null}
        </span>
        <ChevronRight size={16} aria-hidden className="shrink-0" />
      </button>
    </form>
  );
}
