import { createHash } from "node:crypto";
import { systemClock } from "@/lib/clock";
import { DomainError } from "@/lib/errors";
import { getActorQuietly } from "@/lib/session";
import { inboxSummary } from "@/services/notifications";

const NOTHING = { unread: 0, critical: 0, latest: null };

/**
 * What the bell needs, checked every minute while the app is open. When
 * nothing changed the reply is an empty 304, which suits weak networks. The
 * check does not count as activity, so an open page still logs out when idle.
 */
export async function GET(request: Request) {
  const actor = await getActorQuietly();
  if (!actor) return new Response(null, { status: 401 });
  let summary;
  try {
    summary = await inboxSummary({ actor, clock: systemClock });
  } catch (error) {
    // A login with no inbox (an operator login not linked to an operator) just has nothing new.
    if (!(error instanceof DomainError)) throw error;
    summary = NOTHING;
  }
  const body = JSON.stringify(summary);
  const etag = `"${createHash("sha1").update(body).digest("base64url")}"`;
  const headers = { ETag: etag, "Cache-Control": "private, no-cache" };
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(body, { headers: { ...headers, "Content-Type": "application/json" } });
}
