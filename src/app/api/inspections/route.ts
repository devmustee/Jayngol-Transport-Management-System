import { NextResponse } from "next/server";
import { systemClock } from "@/lib/clock";
import { DomainError, ForbiddenError } from "@/lib/errors";
import { getActor } from "@/lib/session";
import { recordInspection } from "@/services/inspections";

/** The offline queue posts here. The status code tells it whether to retry. */
export async function POST(request: Request) {
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: "Log in again." }, { status: 401 });
  const body = await request.json().catch(() => null);
  try {
    return NextResponse.json(await recordInspection({ actor, clock: systemClock }, body));
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof DomainError) {
      const detail = Object.values(error.fieldErrors ?? {})[0];
      return NextResponse.json({ error: detail ?? error.message }, { status: 400 });
    }
    throw error;
  }
}
