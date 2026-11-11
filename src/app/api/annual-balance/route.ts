import { businessDate, systemClock } from "@/lib/clock";
import { ForbiddenError } from "@/lib/errors";
import { getActor } from "@/lib/session";
import { ANNUAL_COLUMNS, annualBalance, annualRows, parseYear } from "@/services/annual-balance";
import { reportCsv } from "@/services/reports";

export async function GET(request: Request) {
  const actor = await getActor();
  if (!actor) return new Response(null, { status: 401 });
  const year = parseYear(new URL(request.url).searchParams.get("year"), businessDate(systemClock()));
  try {
    const report = await annualBalance({ actor, clock: systemClock }, year);
    return new Response(reportCsv({ columns: ANNUAL_COLUMNS, rows: annualRows(report) }), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="annual-balance-${year}.csv"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof ForbiddenError) return new Response(null, { status: 403 });
    throw error;
  }
}
