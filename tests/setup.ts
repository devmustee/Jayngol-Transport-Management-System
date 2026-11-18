import { beforeAll } from "vitest";
import { db } from "@/db";
import { jobRuns } from "@/db/schema";

// Issuing with a past date raises the days the nightly job has already done, so
// each file starts as if the job had never run, whatever ran before it.
beforeAll(async () => {
  await db.delete(jobRuns);
});
