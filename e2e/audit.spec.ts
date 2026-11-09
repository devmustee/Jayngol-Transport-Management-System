import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { BASE_URL, idsPath, PHONE_WIDTH_LIMIT, STAFF_ROLES, STAFF_ROUTES, statePath, WIDTHS, type AuditRole } from "./config";
import { layoutFindings, pageWeight } from "./measure";

const ids: Record<string, string> = JSON.parse(readFileSync(idsPath, "utf8"));
const fill = (route: string) => route.replace(/:(\w+)/g, (_, key: string) => ids[key]!);
const AXE_WIDTHS = new Set<number>([375, 1440]);

async function audit(page: Page, route: string, width: number, expectPath = true) {
  const broken: string[] = [];
  page.on("pageerror", (error) => broken.push(`script error: ${error.message.slice(0, 160)}`));
  const response = await page.goto(BASE_URL + fill(route), { waitUntil: "load" });
  if (expectPath && new URL(page.url()).pathname !== fill(route)) {
    test.skip(true, "This role is sent elsewhere");
  }
  if (!response || response.status() >= 400) broken.push(`status ${response?.status()}`);
  const weight = width === 375 ? await pageWeight(page) : null;
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);

  const layout = await layoutFindings(page, width < PHONE_WIDTH_LIMIT);
  let axe: { id: string; impact: string; nodes: number; sample: string }[] = [];
  if (AXE_WIDTHS.has(width)) {
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    axe = result.violations.map((v) => ({
      id: v.id,
      impact: v.impact ?? "unknown",
      nodes: v.nodes.length,
      sample: v.nodes[0]?.target.join(" ").slice(0, 100) ?? "",
    }));
  }
  await test.info().attach("audit", {
    contentType: "application/json",
    body: JSON.stringify({ route, width, broken, layout, axe, weight }),
  });
  expect.soft(broken, "page must load cleanly").toEqual([]);
  expect.soft(layout, "no sideways scroll or small tap targets").toEqual([]);
  expect.soft(axe, "no accessibility violations").toEqual([]);
}

function suite(role: AuditRole | "anonymous", routes: readonly string[]) {
  for (const width of WIDTHS) {
    test.describe(`${role} @${width}`, () => {
      test.use({
        viewport: { width, height: 800 },
        storageState: role === "anonymous" ? { cookies: [], origins: [] } : statePath(role),
      });
      for (const route of routes) {
        test(route, async ({ page }) => audit(page, route, width));
      }
    });
  }
}

for (const role of STAFF_ROLES) suite(role, STAFF_ROUTES);
suite("operator", ["/me"]);
suite("anonymous", ["/login"]);
