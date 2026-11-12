import { LinkButton } from "@/components/ui";
import { StatusPanel } from "./status-panel";

export function NotFoundPanel({ home, homeLabel = "Go to home" }: { home: string; homeLabel?: string }) {
  return (
    <StatusPanel
      code="404 · Not found"
      title="We couldn't find that page"
      actions={<LinkButton href={home} variant="gold">{homeLabel}</LinkButton>}
    >
      <p>The link may be old, or the record may have been removed. Check the address, or start again from home.</p>
    </StatusPanel>
  );
}
