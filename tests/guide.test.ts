import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { helpForPage, searchTopics, topicFor, topicsFor, TOPICS } from "@/guide";
import { rolesWith } from "@/lib/permissions";

const APP = join(process.cwd(), "src/app");

/** Every page address, with [segments] as patterns and (groups) left out. */
function routes(dir = APP): RegExp[] {
  const found: RegExp[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...routes(path));
    else if (name === "page.tsx") {
      const url = `/${relative(APP, dir)}`
        .split("/")
        .filter((part) => !/^\(.+\)$/.test(part))
        .join("/")
        .replace(/\[[^\]]+\]/g, "[^/]+");
      found.push(new RegExp(`^${url === "" ? "/" : url}$`));
    }
  }
  return found;
}
const ROUTES = routes();
const isPage = (href: string) => ROUTES.some((route) => route.test(href.split(/[?#]/)[0]!));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("the Guide's topics", () => {
  it("have unique, simple ids", () => {
    const ids = TOPICS.map((topic) => topic.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("are each seen by someone, and point only at real pages and topics", () => {
    for (const topic of TOPICS) {
      expect(rolesWith(topic.permission).length, topic.id).toBeGreaterThan(0);
      for (const page of topic.pages) expect(isPage(page), `${topic.id}: ${page}`).toBe(true);
      for (const link of topic.links ?? []) expect(isPage(link.href), `${topic.id}: ${link.href}`).toBe(true);
      for (const id of topic.related ?? []) expect(TOPICS.some((other) => other.id === id), `${topic.id}: ${id}`).toBe(true);
      for (const about of topic.about) expect(existsSync(about.split(" ")[0]!), `${topic.id}: ${about}`).toBe(true);
      expect(topic.summary.length, topic.id).toBeLessThanOrEqual(220);
    }
  });

  it("explain every page that shows a help link", () => {
    const asked = sources(APP).flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/helpForPage\(ctx\.actor\.role, "([^"]+)"\)/g)].map((match) => match[1]!),
    );
    expect(asked.length).toBeGreaterThan(0);
    for (const page of asked) expect(TOPICS.some((topic) => topic.pages.includes(page)), page).toBe(true);
  });
});

describe("who sees what", () => {
  it("shows each person only the topics their role can do", () => {
    const ids = (role: Parameters<typeof topicsFor>[0]) => topicsFor(role).map((topic) => topic.id);
    expect(ids("assistant_manager")).toEqual(expect.arrayContaining(["record-payment", "cash-close", "bank-confirm"]));
    expect(ids("owner")).not.toContain("record-payment");
    expect(ids("supervisor")).toEqual([]);
    expect(topicFor("owner", "cash-close")).toBeNull();
    expect(topicFor("manager", "cash-close")?.id).toBe("cash-close");
    expect(topicFor("manager", "no-such-topic")).toBeNull();
  });

  it("links a page to its topic only for someone who can see it", () => {
    expect(helpForPage("manager", "/bank")?.id).toBe("bank-confirm");
    expect(helpForPage("owner", "/bank")).toBeNull();
    expect(helpForPage("manager", "/tricycles")).toBeNull();
  });
});

describe("searching the Guide", () => {
  it("finds by title words first, then keywords, then the text", () => {
    expect(searchTopics("manager", "close cash")[0]?.id).toBe("cash-close");
    expect(searchTopics("manager", "teller").map((topic) => topic.id)).toContain("move-money");
    expect(searchTopics("manager", "Typo")[0]?.id).toBe("correct-count");
    expect(searchTopics("manager", "zzzz")).toEqual([]);
    expect(searchTopics("manager", "  ")).toHaveLength(topicsFor("manager").length);
  });

  it("never finds a topic the role cannot see", () => {
    expect(searchTopics("owner", "payment").map((topic) => topic.id)).not.toContain("record-payment");
  });
});
