import { can, type Role } from "@/lib/permissions";
import { FIELD_TOPICS } from "./topics/field";
import { FLEET_TOPICS } from "./topics/fleet";
import { MONEY_TOPICS } from "./topics/money";
import { OPERATOR_TOPICS } from "./topics/operator";
import { RECORDS_TOPICS } from "./topics/records";
import { REFUSALS } from "./refusals";
import { TOURS, type Tour, type TourStep } from "./tours";
import { GUIDE_AREAS, type GuideArea, type GuideTopic } from "./types";

export { GUIDE_AREAS, TOURS, type GuideArea, type GuideTopic, type Tour, type TourStep };

export const TOPICS: GuideTopic[] = [...MONEY_TOPICS, ...FLEET_TOPICS, ...FIELD_TOPICS, ...RECORDS_TOPICS, ...OPERATOR_TOPICS];

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

/** The tours a role is offered. */
export const toursFor = (role: Role) => TOURS.filter((tour) => can(role, tour.permission));

/** One tour, if this role is offered it. */
export function tourFor(role: Role, id: string) {
  return toursFor(role).find((tour) => tour.id === id) ?? null;
}

/** The tour that walks through a page, for its "Show me how". */
export const tourForPage = (role: Role, path: string) => toursFor(role).find((tour) => tour.page === path) ?? null;

/** The tour that shows a topic on its page. */
export const tourForTopic = (role: Role, topicId: string) => toursFor(role).find((tour) => tour.topic === topicId) ?? null;

/** The topic that explains why a save was refused, from the words of the refusal and its field messages. */
export function helpForRefusal(role: Role, texts: string[]) {
  const refusal = REFUSALS.find((one) => texts.some((text) => text.includes(one.says)));
  return refusal ? topicFor(role, refusal.topic) : null;
}
