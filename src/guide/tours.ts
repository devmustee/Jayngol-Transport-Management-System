import type { Permission } from "@/lib/permissions";

/**
 * One stop on a tour. `target` names a `data-tour="…"` marker on the page; a
 * step whose marker is not showing (a closed count has no count box, the menu
 * item is behind More) is left out, and a step with no target is a card in the
 * middle of the screen.
 */
export type TourStep = {
  target?: string;
  title: string;
  body: string;
  /** Only for people who have the Guide: those who can see at least one topic. */
  guide?: true;
};

export type Tour = {
  /** Stored against each person once they finish or skip it. Never change it once shipped. */
  id: string;
  title: string;
  /** Who is offered it: the permission that lets them do the work. */
  permission: Permission;
  /** The page it walks through. It starts there with ?tour=<id>. */
  page: string;
  /** The Guide topic it shows on the page, which links to it as "Show me on the page". */
  topic?: string;
  steps: TourStep[];
  /** The code whose markers it points at, to update together. */
  about: string[];
};

export const TOURS: Tour[] = [
  {
    id: "welcome",
    title: "A look round the app",
    permission: "dashboard.view",
    page: "/dashboard",
    steps: [
      {
        title: "Welcome to Jayngol",
        body: "A one-minute look round. Tap Next to go on, or Skip at any time.",
      },
      {
        target: "menu",
        title: "The menu",
        body: "Every page you can use is here. On a phone the main ones are along the bottom, and More opens the rest.",
      },
      {
        target: "bell",
        title: "Notifications",
        body: "Things waiting for you, such as a handover to accept or a count that did not match. A red number means it is urgent.",
      },
      {
        target: "account",
        title: "Your account",
        body: "Your name opens your account, where you change your password and log out.",
      },
      {
        guide: true,
        title: "Help on the page",
        body: "Look for the ? next to a page title. It opens the Guide on how that page works. Show me how walks you through the page itself.",
      },
      {
        title: "That is all",
        body: "You can take this tour again from your Account page.",
      },
    ],
    about: ["src/components/nav.tsx", "src/components/notification-bell.tsx", "src/app/(staff)/layout.tsx"],
  },
  {
    id: "cash-close",
    title: "Closing your cash",
    permission: "cash.close",
    page: "/cash",
    topic: "cash-close",
    steps: [
      {
        target: "cash-date",
        title: "Choose the day",
        body: "The page opens on today. Pick an earlier day to close it or look back at its count.",
      },
      {
        target: "cash-card",
        title: "One card for each person",
        body: "Each card is one person's cash since their last count. The Assistant Manager closes every day, the Manager once a week.",
      },
      {
        target: "cash-days",
        title: "What came in and went out",
        body: "Each day with cash in or out is listed. Tap a day to see every naira. Cash expected is what should be in hand.",
      },
      {
        target: "cash-count",
        title: "Count and type it",
        body: "Count every note you hold now and type the total. The app tells you at once whether it matches.",
      },
      {
        target: "cash-close-button",
        title: "Close it",
        body: "If it does not match, say why in Explanation first. A difference is sent to the Manager, and to the Owner if it is ₦2,000 or more.",
      },
      {
        target: "cash-recent",
        title: "Recent counts",
        body: "The latest counts of everyone's cash. Only differences shows the counts that did not match.",
      },
      {
        target: "help",
        title: "More in the Guide",
        body: "The ? opens the Guide on cash close, including how to correct a count typed wrong.",
      },
    ],
    about: ["src/app/(staff)/cash/page.tsx", "src/components/forms/cash-close-form.tsx"],
  },
];
