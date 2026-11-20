import type { Permission } from "@/lib/permissions";

export const GUIDE_AREAS = {
  money: "Money",
  fleet: "Tricycles and operators",
  field: "Field work",
  admin: "Staff",
  operator: "Your work at Jayngol",
} as const;

export type GuideArea = keyof typeof GUIDE_AREAS;

/**
 * One question the Guide answers. Written in plain words, short enough to
 * read standing up. When the rule it explains changes, change it here in the
 * same commit: `about` names the code it describes.
 */
export type GuideTopic = {
  /** The address: /guide/<id>. Never change it once shipped; links point here. */
  id: string;
  area: GuideArea;
  /** A question, as people would ask it. */
  title: string;
  /** One or two sentences: the answer in short. */
  summary: string;
  /** Who sees the topic: the permission that lets them do the task. */
  permission: Permission;
  /** The pages this topic is about. The "?" on those pages links here. */
  pages: string[];
  /** What to do, one step per line. */
  steps?: string[];
  /** Rules and things that surprise people. */
  goodToKnow?: string[];
  /** Pages to go to, with what they are for. */
  links?: { href: string; label: string }[];
  /** Other topics on the same work. */
  related?: string[];
  /** Other words people search with. */
  keywords?: string[];
  /** The code whose rules this explains, to update together. */
  about: string[];
};
