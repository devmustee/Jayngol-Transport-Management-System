import { z } from "zod";
import { businessDate, systemClock } from "@/lib/clock";
import { ForbiddenError } from "@/lib/errors";
import { getActor } from "@/lib/session";
import { isReportKey, reportCsv, runReport } from "@/services/reports";

const dateOr = (value: string | null, fallback: string) => (z.iso.date().safeParse(value).success ? value! : fallback);

export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const actor = await getActor();
  if (!actor) return new Response(null, { status: 401 });
  const { key } = await params;
  if (!isReportKey(key)) return new Response(null, { status: 404 });
  const query = new URL(request.url).searchParams;
  const today = businessDate(systemClock());
  const [from, to] = [dateOr(query.get("from"), `${today.slice(0, 8)}01`), dateOr(query.get("to"), today)].sort() as [string, string];
  try {
    const report = await runReport({ actor, clock: systemClock }, key, { from, to });
    return new Response(reportCsv(report), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${key}-${from}-to-${to}.csv"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof ForbiddenError) return new Response(null, { status: 403 });
    throw error;
  }
}
