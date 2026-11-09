import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { layoutFindings } from "./measure";

// A clean audit only means something if these checks can fail.
test("the audit catches a deliberately broken page", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("http://localhost:3200/login");
  await page.setContent(`<!doctype html><html lang="en"><head><title>x</title></head><body>
    <main><h1>Broken</h1>
      <div style="width:900px;height:10px">wide</div>
      <button style="height:20px;padding:0">Small</button>
      <p style="color:#ccc;background:#fff">Pale text</p>
      <details><summary style="height:44px;display:block">More</summary>
        <div style="width:1200px;height:10px">hidden wide</div></details>
    </main></body></html>`);
  const layout = await layoutFindings(page, true);
  expect(layout.some((f) => f.type === "overflow" && f.detail.startsWith("8"))).toBe(true);
  expect(layout.some((f) => f.type === "tap-target" && f.detail.includes("Small"))).toBe(true);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2aa"]).analyze();
  expect(axe.violations.map((v) => v.id)).toContain("color-contrast");
});
