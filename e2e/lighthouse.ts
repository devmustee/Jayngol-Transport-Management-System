/** Mobile Lighthouse scores for the main screens, against the audit build. */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { BASE_URL, statePath, type AuditRole } from "./config";

const PAGES: [string, AuditRole | null][] = [
  ["/login", null], ["/dashboard", "manager"], ["/tricycles", "manager"], ["/money", "manager"],
  ["/payments/new", "manager"], ["/inspections", "supervisor"], ["/me", "operator"],
];

function cookie(role: AuditRole) {
  const state = JSON.parse(readFileSync(statePath(role), "utf8")) as { cookies: { name: string; value: string }[] };
  return state.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function main() {
  const server = spawn("npm", ["run", "audit:serve"], { stdio: "ignore", detached: true });
  try {
    for (let i = 0; i < 60; i++) {
      if (await fetch(`${BASE_URL}/login`).then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const out: unknown[] = [];
    mkdirSync("e2e/results", { recursive: true });
    for (const [path, role] of PAGES) {
      const file = "e2e/results/lighthouse-last.json";
      const args = [
        "lighthouse", BASE_URL + path, "--quiet", "--output=json", `--output-path=${file}`,
        "--only-categories=performance,accessibility,best-practices", "--chrome-flags=--headless=new",
      ];
      if (role) args.push(`--extra-headers=${JSON.stringify({ Cookie: cookie(role) })}`);
      execFileSync("npx", args, { stdio: "ignore", env: { ...process.env, CHROME_PATH: chromium.executablePath() } });
      const report = JSON.parse(readFileSync(file, "utf8"));
      const row = {
        path,
        finalUrl: report.finalDisplayedUrl,
        performance: Math.round(report.categories.performance.score * 100),
        accessibility: Math.round(report.categories.accessibility.score * 100),
        bestPractices: Math.round(report.categories["best-practices"].score * 100),
        lcp: report.audits["largest-contentful-paint"].displayValue,
        cls: report.audits["cumulative-layout-shift"].displayValue,
        tbt: report.audits["total-blocking-time"].displayValue,
      };
      console.log(row);
      out.push(row);
    }
    writeFileSync("e2e/results/lighthouse.json", JSON.stringify(out, null, 2));
  } finally {
    if (server.pid) process.kill(-server.pid);
  }
}

main().catch((error) => {
  console.error(String(error).slice(0, 500));
  process.exit(1);
});
