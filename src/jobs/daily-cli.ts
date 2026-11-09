import { pgClient } from "../db";
import { systemClock } from "../lib/clock";
import { runDailyJob } from "../services/daily-job";

runDailyJob(systemClock)
  .then((processed) => console.log("Processed:", processed.join(", ") || "nothing to do"))
  .finally(() => pgClient.end());
