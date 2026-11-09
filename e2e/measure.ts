import type { Page } from "@playwright/test";
import { MIN_TAP_HEIGHT } from "./config";

export type Finding = { type: "overflow" | "tap-target"; detail: string };

/** Bytes this page needed on an empty cache, read as soon as it has loaded. */
export function pageWeight(page: Page) {
  return page.evaluate(() => {
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const sum = (ext: string) =>
      resources.filter((r) => new URL(r.name).pathname.endsWith(ext)).reduce((n, r) => n + r.encodedBodySize, 0);
    const [nav] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
    return { jsBytes: sum(".js"), cssBytes: sum(".css"), htmlBytes: nav?.encodedBodySize ?? 0 };
  });
}

/** Runs in the page, with every folded section opened so nothing escapes. */
export function layoutFindings(page: Page, checkTaps: boolean, minTap = MIN_TAP_HEIGHT) {
  return page.evaluate(
    ({ checkTaps, minTap }): Finding[] => {
      document.querySelectorAll("details").forEach((d) => (d.open = true));
      const findings: Finding[] = [];
      const name = (el: Element) => {
        const text = (el.textContent || (el as HTMLInputElement).name || "").trim().replace(/\s+/g, " ").slice(0, 40);
        return `${el.tagName.toLowerCase()} "${text}"`;
      };
      const root = document.documentElement;
      const extra = root.scrollWidth - root.clientWidth;
      if (extra > 0) {
        const clipped = (el: Element) => {
          for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            if (getComputedStyle(p).overflowX !== "visible") return true;
          }
          return false;
        };
        const wide = [...document.body.querySelectorAll("*")]
          .filter((el) => el.getBoundingClientRect().right > root.clientWidth + 1 && !clipped(el))
          .slice(-3)
          .map(name);
        findings.push({ type: "overflow", detail: `${extra}px wider than the screen: ${wide.join("; ")}` });
      }
      if (checkTaps) {
        const targets = document.querySelectorAll(
          'a[href],button,select,input:not([type=hidden]),textarea,summary,[role="button"]',
        );
        targets.forEach((el) => {
          const input = el as HTMLInputElement;
          const target = input.type === "checkbox" || input.type === "radio" ? (el.closest("label") ?? el) : el;
          const box = target.getBoundingClientRect();
          const style = getComputedStyle(target);
          if (box.width === 0 || box.height === 0 || style.visibility === "hidden") return;
          if (box.height >= minTap) return;
          // A link inside a sentence is exempt, as in WCAG 2.5.8.
          if (el.tagName === "A" && style.display === "inline") {
            const words = [...(el.parentElement?.childNodes ?? [])]
              .filter((node) => node.nodeType === Node.TEXT_NODE)
              .map((node) => node.textContent ?? "")
              .join("")
              .replace(/[^\p{L}\p{N}]/gu, "");
            if (words.length >= 20) return;
          }
          findings.push({ type: "tap-target", detail: `${Math.round(box.height)}px high: ${name(target)}` });
        });
      }
      return findings;
    },
    { checkTaps, minTap },
  );
}
