import { mkdirSync, writeFileSync } from "node:fs";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { resultsPath } from "./config";

/** Collects every page's measurements into one file, pass or fail. */
export default class AuditReporter implements Reporter {
  private rows: unknown[] = [];
  private crashed: string[] = [];

  onTestEnd(test: TestCase, result: TestResult) {
    const role = test.parent.title.split(" @")[0];
    const body = result.attachments.find((a) => a.name === "audit")?.body;
    if (body) this.rows.push({ role, ...JSON.parse(body.toString()) });
    else if (result.status !== "skipped") this.crashed.push(`${test.titlePath().join(" > ")}: ${result.error?.message?.slice(0, 200)}`);
  }

  onEnd() {
    mkdirSync("e2e/results", { recursive: true });
    writeFileSync(resultsPath, JSON.stringify({ rows: this.rows, crashed: this.crashed }));
    console.log(`Audited ${this.rows.length} page views, ${this.crashed.length} could not be measured. See ${resultsPath}.`);
  }
}
