"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Footprints, X } from "lucide-react";
import { saveTourProgressAction } from "@/app/actions";

export type ClientTour = {
  id: string;
  title: string;
  page: string;
  steps: { target?: string; title: string; body: string }[];
};

type Rect = { top: number; left: number; width: number; height: number };

const GAP = 12;
const EDGE = 16;
const PAD = 6;
const DIM = "rgba(0, 0, 0, 0.55)";

/** The first marker with this name that is on screen: the sidebar on a computer, the bottom bar on a phone. */
function findTarget(name: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-tour="${CSS.escape(name)}"]`)) {
    if (el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden") return el;
  }
  return null;
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Scrolls the marker up to just below the phone's header, leaving the room
 * under it for the card. The menu and the bar along the bottom stay put, so
 * the page is not moved for them.
 */
function bringIntoView(target: HTMLElement) {
  for (let el: HTMLElement | null = target; el; el = el.parentElement) {
    const position = getComputedStyle(el).position;
    if (position === "fixed" || position === "sticky") return;
  }
  const box = target.getBoundingClientRect();
  const header = document.querySelector("header.sticky")?.getBoundingClientRect().height ?? 0;
  window.scrollTo({ top: window.scrollY + box.top - header - EDGE * 2, behavior: reducedMotion() ? "auto" : "smooth" });
}

/**
 * Calls back once the page shows one of the tour's markers. A page may still
 * be loading behind its skeleton when the tour is asked for. Gives up after 8
 * seconds, and a tour with no markers at all starts at once.
 */
function whenMarked(tour: ClientTour, callback: () => void) {
  const targets = tour.steps.flatMap((step) => (step.target ? [step.target] : []));
  const ready = () => targets.length === 0 || targets.some((name) => findTarget(name));
  const go = () => requestAnimationFrame(callback);
  if (ready()) return go();
  const observer = new MutationObserver(() => {
    if (!ready()) return;
    stop();
    go();
  });
  const timer = window.setTimeout(() => stop(), 8000);
  const stop = () => {
    observer.disconnect();
    window.clearTimeout(timer);
  };
  observer.observe(document.body, { childList: true, subtree: true });
}

/** Where the card goes: below the marker, above it, beside it, or along the bottom of the screen. */
function placeCard(target: Rect | null, card: { width: number; height: number }) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(360, vw - EDGE * 2);
  if (!target) return { width, left: (vw - width) / 2, top: Math.max(EDGE, (vh - card.height) / 2) };
  const centred = Math.min(Math.max(target.left + target.width / 2 - width / 2, EDGE), vw - width - EDGE);
  const below = target.top + target.height + PAD + GAP;
  if (below + card.height <= vh - EDGE) return { width, left: centred, top: below };
  const above = target.top - PAD - GAP - card.height;
  if (above >= EDGE) return { width, left: centred, top: above };
  const middle = Math.min(Math.max(target.top + target.height / 2 - card.height / 2, EDGE), vh - card.height - EDGE);
  const right = target.left + target.width + PAD + GAP;
  if (right + width <= vw - EDGE) return { width, left: right, top: middle };
  const left = target.left - PAD - GAP - width;
  if (left >= EDGE) return { width, left, top: middle };
  return { width, left: (vw - width) / 2, top: vh - card.height - EDGE };
}

/**
 * Runs Guide tours: `?tour=<id>` on the tour's page starts one, and the
 * welcome tour is offered once on Home until it is finished or skipped. Each
 * step lights up one marker and explains it; markers not showing are left out.
 */
export function Tours({ tours, offerWelcome }: { tours: ClientTour[]; offerWelcome: boolean }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const [run, setRun] = useState<{ tour: ClientTour; steps: ClientTour["steps"]; index: number } | null>(null);
  const [offered, setOffered] = useState(offerWelcome);
  const welcome = tours.find((tour) => tour.id === "welcome");

  const start = useCallback((tour: ClientTour) => {
    const steps = tour.steps.filter((step) => !step.target || findTarget(step.target));
    if (steps.length > 0) setRun({ tour, steps, index: 0 });
  }, []);

  const running = useRef(run);
  useEffect(() => {
    running.current = run;
  });
  const finish = useCallback((status: "done" | "skipped") => {
    if (running.current) void saveTourProgressAction(running.current.tour.id, status);
    setRun(null);
    setOffered(false);
  }, []);

  // ?tour=<id> starts that tour, then leaves the address so a refresh does not start it again.
  const asked = params.get("tour");
  useEffect(() => {
    if (!asked) return;
    const tour = tours.find((one) => one.id === asked && one.page === pathname);
    const url = new URL(window.location.href);
    url.searchParams.delete("tour");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    // Not cancelled when the address changes: taking ?tour out of it runs this again.
    if (tour) whenMarked(tour, () => start(tour));
  }, [asked, pathname, tours, start]);

  if (run) return <TourStepView key={run.tour.id} run={run} setRun={setRun} finish={finish} />;
  if (offered && welcome && pathname === welcome.page) {
    return (
      <div
        role="region"
        aria-label="Welcome tour"
        className="print:hidden fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom)+5rem)] z-40 mx-auto max-w-sm rounded-2xl border border-gold-light/60 bg-card p-4 shadow-xl md:inset-x-auto md:right-8 md:bottom-8"
      >
        <div className="flex items-start gap-3">
          <Footprints size={22} aria-hidden className="mt-0.5 shrink-0 text-gold-deep" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-ink">New here?</p>
            <p className="mt-0.5 text-sm text-muted">Take a one-minute look round the app.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setOffered(false);
                  start(welcome);
                }}
                className="min-h-11 rounded-xl bg-ink px-4 font-semibold text-gold-light"
              >
                Start the tour
              </button>
              <button
                type="button"
                onClick={() => {
                  setOffered(false);
                  void saveTourProgressAction(welcome.id, "skipped");
                }}
                className="min-h-11 rounded-xl border border-line px-4 font-semibold text-ink"
              >
                Not now
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
  return null;
}

function TourStepView({
  run,
  setRun,
  finish,
}: {
  run: { tour: ClientTour; steps: ClientTour["steps"]; index: number };
  setRun: (run: { tour: ClientTour; steps: ClientTour["steps"]; index: number }) => void;
  finish: (status: "done" | "skipped") => void;
}) {
  const step = run.steps[run.index]!;
  const last = run.index === run.steps.length - 1;
  const cardRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [cardSize, setCardSize] = useState({ width: 360, height: 200 });
  const [, redraw] = useState(0);

  const go = (index: number) => setRun({ ...run, index });

  // Bring the marker into view, then follow it as the page scrolls or turns.
  useEffect(() => {
    const target = step.target ? findTarget(step.target) : null;
    if (!target) {
      setRect(null);
      return;
    }
    bringIntoView(target);
    let frame = 0;
    const read = () => {
      const box = target.getBoundingClientRect();
      setRect({ top: box.top, left: box.left, width: box.width, height: box.height });
    };
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(read);
    };
    read();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
      observer.disconnect();
    };
  }, [step.target]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const { offsetWidth: width, offsetHeight: height } = card;
    if (width !== cardSize.width || height !== cardSize.height) setCardSize({ width, height });
  });

  // Each step is read out from its title.
  useEffect(() => {
    cardRef.current?.focus({ preventScroll: true });
  }, [run.index]);

  useEffect(() => {
    const onResize = () => redraw((n) => n + 1);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish("skipped");
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey);
    };
  }, [finish]);

  const place = placeCard(step.target ? rect : null, cardSize);
  const hole =
    step.target && rect
      ? { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 }
      : null;
  const titleId = `tour-${run.tour.id}-${run.index}`;

  return (
    <div className="print:hidden fixed inset-0 z-[60]">
      {/* Taps outside the card do nothing, so the page cannot change under the tour. */}
      {hole ? (
        <>
          {/* Four plain panels dim round the lit item: a wide shadow or a newer colour may not paint on older phones. */}
          <div aria-hidden className="absolute inset-x-0 top-0" style={{ height: Math.max(0, hole.top), background: DIM }} />
          <div aria-hidden className="absolute inset-x-0 bottom-0" style={{ top: hole.top + hole.height, background: DIM }} />
          <div aria-hidden className="absolute left-0" style={{ top: hole.top, height: hole.height, width: Math.max(0, hole.left), background: DIM }} />
          <div aria-hidden className="absolute right-0" style={{ top: hole.top, height: hole.height, left: hole.left + hole.width, background: DIM }} />
          <div
            aria-hidden
            className="absolute rounded-xl"
            style={{ ...hole, outline: "2px solid var(--color-gold-light)" }}
          />
        </>
      ) : (
        <div aria-hidden className="absolute inset-0" style={{ background: DIM }} />
      )}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="absolute rounded-2xl bg-card p-4 shadow-2xl outline-none"
        style={{ top: place.top, left: place.left, width: place.width }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-muted">
              {run.tour.title} · {run.index + 1} of {run.steps.length}
            </p>
            <h2 id={titleId} className="mt-1 text-base font-bold text-ink">
              {step.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={() => finish("skipped")}
            aria-label="Skip the tour"
            className="-mt-1.5 -mr-1.5 flex size-10 shrink-0 items-center justify-center rounded-full text-muted hover:bg-card-subtle"
          >
            <X size={18} aria-hidden />
          </button>
        </div>
        <p className="mt-1.5 text-sm leading-relaxed text-ink" aria-live="polite">
          {step.body}
        </p>
        <div className="mt-4 flex items-center justify-between gap-2">
          {last ? (
            <span />
          ) : (
            <button type="button" onClick={() => finish("skipped")} className="min-h-11 px-1 text-sm font-semibold text-muted">
              Skip
            </button>
          )}
          <div className="flex gap-2">
            {run.index > 0 ? (
              <button
                type="button"
                onClick={() => go(run.index - 1)}
                className="min-h-11 rounded-xl border border-line px-4 font-semibold text-ink"
              >
                Back
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => (last ? finish("done") : go(run.index + 1))}
              className="min-h-11 rounded-xl bg-ink px-4 font-semibold text-gold-light"
            >
              {last ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
