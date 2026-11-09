import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { systemClock } from "@/lib/clock";
import { runDailyJob } from "@/services/daily-job";

const digest = (value: string) => createHash("sha256").update(value).digest();

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

/** Called by the scheduler at 00:05 WAT. Safe to call again at any time. */
export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const processed = await runDailyJob(systemClock);
  return NextResponse.json({ processed });
}
