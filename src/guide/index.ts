import { can, type Role } from "@/lib/permissions";
import { MONEY_TOPICS } from "./topics/money";
import { GUIDE_AREAS, type GuideArea, type GuideTopic } from "./types";

export { GUIDE_AREAS, type GuideArea, type GuideTopic };

export const TOPICS: GuideTopic[] = [...MONEY_TOPICS];

const byId = new Map(TOPICS.map((topic) => [topic.id, topic]));

/** The topics a role may see. */
export const topicsFor = (role: Role) => TOPICS.filter((topic) => can(role, topic.permission));

/** One topic, if this role may see it. */
export function topicFor(role: Role, id: string) {
  const topic = byId.get(id);
  return topic && can(role, topic.permission) ? topic : null;
}

/** The topic that explains a page, for the "?" link on it. */
export function helpForPage(role: Role, path: string) {
  return topicsFor(role).find((topic) => topic.pages.includes(path)) ?? null;
}

const words = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9₦ ]+/g, " ").split(/\s+/).filter(Boolean);

/**
 * Finds topics by every word typed, ranked so a word in the title counts most,
 * then the keywords, then the rest of the text.
 */
export function searchTopics(role: Role, query: string) {
  const wanted = words(query);
  if (wanted.length === 0) return topicsFor(role);
  return topicsFor(role)
    .map((topic) => {
      const fields = [
        { text: words(topic.title), weight: 5 },
        { text: (topic.keywords ?? []).flatMap(words), weight: 3 },
        { text: words([topic.summary, ...(topic.steps ?? []), ...(topic.goodToKnow ?? [])].join(" ")), weight: 1 },
      ];
      let score = 0;
      for (const word of wanted) {
        const hit = fields.reduce((best, field) => (field.text.some((w) => w.startsWith(word)) ? Math.max(best, field.weight) : best), 0);
        if (hit === 0) return { topic, score: 0 };
        score += hit;
      }
      return { topic, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((row) => row.topic);
}
