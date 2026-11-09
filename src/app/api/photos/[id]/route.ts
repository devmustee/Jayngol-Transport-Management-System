import { systemClock } from "@/lib/clock";
import { ForbiddenError } from "@/lib/errors";
import { isUuid } from "@/lib/fields";
import { getActor } from "@/lib/session";
import { getPhoto } from "@/services/inspections";

/** Every request is checked against the session. The URL alone opens nothing. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getActor();
  if (!actor) return new Response(null, { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return new Response(null, { status: 404 });
  let data: Buffer | null;
  try {
    data = await getPhoto({ actor, clock: systemClock }, id);
  } catch (error) {
    if (error instanceof ForbiddenError) return new Response(null, { status: 403 });
    throw error;
  }
  if (!data) return new Response(null, { status: 404 });
  return new Response(new Uint8Array(data), {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=300" },
  });
}
