import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { helpForPage, helpForRefusal, searchTopics, topicFor, topicsFor, TOPICS, tourFor, tourForPage, tourForTopic, toursFor, TOURS } from "@/guide";
import { rolesWith } from "@/lib/permissions";
import { REFUSALS } from "@/guide/refusals";
import { saveTourProgress, tourProgress, tourReport } from "@/services/guide-progress";
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
    expect(ids("supervisor")).toEqual(expect.arrayContaining(["inspect-tricycles", "offences", "workshop", "meetings"]));
    expect(ids("supervisor")).not.toContain("record-payment");
    expect(topicFor("owner", "cash-close")).toBeNull();
    expect(topicFor("manager", "cash-close")?.id).toBe("cash-close");
    expect(topicFor("manager", "no-such-topic")).toBeNull();
  });

  it("links a page to its topic only for someone who can see it", () => {
    expect(helpForPage("manager", "/bank")?.id).toBe("bank-confirm");
    expect(helpForPage("owner", "/bank")).toBeNull();
    expect(helpForPage("manager", "/tricycles")?.id).toBe("add-tricycle");
    expect(helpForPage("manager", "/reports")).toBeNull();
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

describe("refusals that link to the Guide", () => {
  const services = sources(join(process.cwd(), "src/services")).map((file) => readFileSync(file, "utf8")).join("\n");

  it("match words the services still use, and point at real topics", () => {
    for (const refusal of REFUSALS) {
      expect(services.includes(refusal.says), `no longer said: ${refusal.says}`).toBe(true);
      expect(TOPICS.some((topic) => topic.id === refusal.topic), refusal.topic).toBe(true);
    }
  });

  it("find the topic from the message or a field message, for those who can see it", () => {
    expect(helpForRefusal("assistant_manager", ["Please check the highlighted field.", "This reference has already been used on another payment or deposit"])?.id).toBe("record-payment");
    expect(helpForRefusal("manager", ["A different person must confirm R-12, which you recorded."])?.id).toBe("bank-confirm");
    expect(helpForRefusal("owner", ["This count has already been corrected once."])).toBeNull();
    expect(helpForRefusal("manager", ["Something else went wrong."])).toBeNull();
  });
});

describe("the operator's help", () => {
  it("shows operators only their own topics, and staff never see them", () => {
    const mine = topicsFor("operator");
    expect(mine.length).toBeGreaterThan(0);
    for (const topic of mine) expect(topic.area, topic.id).toBe("operator");
    for (const role of ["owner", "manager", "assistant_manager", "supervisor"] as const) {
      expect(topicsFor(role).some((topic) => topic.area === "operator"), role).toBe(false);
    }
    expect(topicFor("operator", "cash-close")).toBeNull();
    expect(searchTopics("operator", "pin")[0]?.id).toBe("my-login");
    expect(searchTopics("operator", "sticker")[0]?.id).toBe("my-fines");
  });

  it("links the operator's page only to operator topics", () => {
    const page = readFileSync(join(APP, "me/page.tsx"), "utf8");
    const ids = [
      ...[...page.matchAll(/<HelpLink id="([^"]+)"/g)].map((match) => match[1]!),
      ...[...page.matchAll(/ASKED_MOST = \[([^\]]+)\]/g)].flatMap((match) => [...match[1]!.matchAll(/"([^"]+)"/g)].map((id) => id[1]!)),
    ];
    expect(ids.length).toBeGreaterThan(3);
    for (const id of ids) expect(topicFor("operator", id)?.id, id).toBe(id);
  });
});

describe("who has taken the tours", () => {
  it("shows the Owner and Manager each person's tours, finished, skipped or not yet", async () => {
    const { ctx: owner } = await makeUser("owner");
    const { ctx: assistant, user: a } = await makeUser("assistant_manager");
    const { user: s } = await makeUser("supervisor");
    await saveTourProgress(assistant, "welcome", "done");
    await saveTourProgress(assistant, "cash-close", "skipped");

    const { staff, tours } = await tourReport(owner);
    const states = (id: string) => Object.fromEntries(staff.find((p) => p.id === id)!.tours.map((t) => [t.id, t.status]));
    expect(states(a.id)).toMatchObject({ welcome: "done", "cash-close": "skipped", "bank-check": "not_yet", "take-payment": "not_yet" });
    expect(states(s.id)).toEqual({ welcome: "not_yet" });
    expect(staff.find((p) => p.id === a.id)!.tours.find((t) => t.id === "welcome")!.at).toBeInstanceOf(Date);
    expect(staff.some((p) => p.role === "operator")).toBe(false);

    const welcome = tours.find((t) => t.id === "welcome")!;
    expect(welcome.offered).toBe(staff.length);
    expect(welcome.done).toBeGreaterThanOrEqual(1);
  });

  it("is only for the Owner and Manager", async () => {
    const { ctx: manager } = await makeUser("manager");
    const { ctx: assistant } = await makeUser("assistant_manager");
    await expect(tourReport(manager)).resolves.toBeTruthy();
    await expect(tourReport(assistant)).rejects.toThrow();
  });
});
