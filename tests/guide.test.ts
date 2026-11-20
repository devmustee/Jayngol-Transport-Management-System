import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { helpForPage, searchTopics, topicFor, topicsFor, TOPICS, tourFor, tourForPage, tourForTopic, toursFor, TOURS } from "@/guide";
import { rolesWith } from "@/lib/permissions";
import { saveTourProgress, tourProgress } from "@/services/guide-progress";
import { makeUser } from "./helpers";

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

describe("the Guide's tours", () => {
  const code = sources(join(process.cwd(), "src")).map((file) => readFileSync(file, "utf8")).join("\n");

  it("have unique ids and point at real pages, topics and markers", () => {
    const ids = TOURS.map((tour) => tour.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const tour of TOURS) {
      expect(id(tour.id), tour.id).toBe(true);
      expect(rolesWith(tour.permission).length, tour.id).toBeGreaterThan(0);
      expect(isPage(tour.page), `${tour.id}: ${tour.page}`).toBe(true);
      if (tour.topic) expect(TOPICS.some((topic) => topic.id === tour.topic), `${tour.id}: ${tour.topic}`).toBe(true);
      for (const about of tour.about) expect(existsSync(about), `${tour.id}: ${about}`).toBe(true);
      expect(tour.steps.length, tour.id).toBeGreaterThan(1);
      for (const step of tour.steps) {
        expect(step.body.length, `${tour.id}: ${step.title}`).toBeLessThanOrEqual(160);
        // A marker is written data-tour="name", or picked in an expression such as tour={… ? "name" : …}.
        if (step.target) {
          const marked = new RegExp(`(data-tour|tour)=(\\{[^\\n]*)?"${step.target}"`).test(code);
          expect(marked, `${tour.id}: no marker "${step.target}"`).toBe(true);
        }
      }
    }
  });

  it("are offered only to the roles that do the work", () => {
    expect(toursFor("supervisor").map((tour) => tour.id)).toEqual(["welcome"]);
    expect(tourFor("owner", "cash-close")).toBeNull();
    expect(tourForPage("assistant_manager", "/cash")?.id).toBe("cash-close");
    expect(tourForTopic("manager", "cash-close")?.id).toBe("cash-close");
    expect(tourForTopic("manager", "record-expense")).toBeNull();
  });
});

const id = (value: string) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value);

describe("remembering tours", () => {
  it("keeps each person's finished and skipped tours apart", async () => {
    const { ctx: assistant } = await makeUser("assistant_manager");
    const { ctx: other } = await makeUser("assistant_manager");
    expect(await tourProgress(assistant)).toEqual({});
    await saveTourProgress(assistant, "welcome", "skipped");
    await saveTourProgress(assistant, "cash-close", "done");
    expect(await tourProgress(assistant)).toEqual({ welcome: "skipped", "cash-close": "done" });
    expect(await tourProgress(other)).toEqual({});
  });

  it("lets a skipped tour be finished later, but never unfinishes one", async () => {
    const { ctx } = await makeUser("manager");
    await saveTourProgress(ctx, "welcome", "skipped");
    await saveTourProgress(ctx, "welcome", "done");
    expect((await tourProgress(ctx)).welcome).toBe("done");
    await saveTourProgress(ctx, "welcome", "skipped");
    expect((await tourProgress(ctx)).welcome).toBe("done");
  });

  it("refuses a tour that does not exist or is not the person's", async () => {
    const { ctx: owner } = await makeUser("owner");
    await expect(saveTourProgress(owner, "no-such-tour", "done")).rejects.toThrow("not one of yours");
    await expect(saveTourProgress(owner, "cash-close", "done")).rejects.toThrow("not one of yours");
    await expect(saveTourProgress(owner, "welcome", "finished" as never)).rejects.toThrow("Unknown tour status");
    expect(await tourProgress(owner)).toEqual({});
  });
});
