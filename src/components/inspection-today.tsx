"use client";

import { CloudOff, Check, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { compressPhoto } from "@/lib/compress-photo";
import {
  allQueued,
  lagosToday,
  putQueued,
  removeQueued,
  type QueuedInspection,
} from "@/lib/inspection-queue";

export type TodayItem = {
  tricycleId: string;
  code: string;
  registration: string;
  operatorName: string;
  washed: boolean | null;
  stickerIntact: boolean | null;
};

type Answer = { washed?: boolean; stickerIntact?: boolean; photo?: string; note?: string; problem?: string };
type Sync = "idle" | "sending" | "offline" | "login";

const RETRY_MS = 20_000;

function YesNo({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | undefined;
  onChange: (value: boolean) => void;
}) {
  const style = (selected: boolean, good: boolean) =>
    `min-h-12 flex-1 rounded-lg border px-3 font-semibold ${
      selected ? (good ? "border-ok bg-ok text-white" : "border-danger bg-danger text-white") : "border-line bg-card"
    }`;
  return (
    <div>
      <div className="mb-1 text-sm font-medium">{label}</div>
      <div className="flex gap-2">
        <button type="button" aria-pressed={value === true} className={style(value === true, true)} onClick={() => onChange(true)}>
          Yes
        </button>
        <button type="button" aria-pressed={value === false} className={style(value === false, false)} onClick={() => onChange(false)}>
          No
        </button>
      </div>
    </div>
  );
}

const Result = ({ good, label }: { good: boolean; label: string }) => (
  <span className={`inline-flex items-center gap-1 text-sm font-medium ${good ? "text-ok" : "text-danger"}`}>
    {good ? <Check size={16} aria-hidden /> : <X size={16} aria-hidden />}
    {label}
  </span>
);

/** Everything is written to the phone first, then sent, so signal never loses work. */
export function InspectionToday({
  date,
  items,
  userId,
}: {
  date: string;
  items: TodayItem[];
  userId: string;
}) {
  const router = useRouter();
  const [queue, setQueue] = useState<QueuedInspection[]>([]);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [sync, setSync] = useState<Sync>("idle");
  const [today, setToday] = useState(date);
  const [search, setSearch] = useState("");
  const [storageProblem, setStorageProblem] = useState(false);
  const draining = useRef(false);

  const reload = useCallback(async () => {
    const all = await allQueued();
    const current = lagosToday();
    const expired = all.filter((row) => row.state === "sent" && row.date < current);
    await Promise.all(expired.map((row) => removeQueued(row.clientId)));
    setQueue(all.filter((row) => !expired.includes(row)));
    setToday(current);
  }, []);

  const drain = useCallback(async () => {
    if (draining.current) return;
    draining.current = true;
    let sentAny = false;
    setSync("sending");
    try {
      const waiting = (await allQueued()).filter((row) => row.state === "pending" && row.userId === userId);
      for (const row of waiting) {
        let response: Response;
        try {
          response = await fetch("/api/inspections", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              clientId: row.clientId,
              tricycleId: row.tricycleId,
              washed: row.washed,
              stickerIntact: row.stickerIntact,
              note: row.note,
              photo: row.photo,
              inspectedAt: row.inspectedAt,
            }),
          });
        } catch {
          setSync("offline");
          return;
        }
        if (response.status === 401) {
          setSync("login");
          return;
        }
        if (response.status >= 500) {
          setSync("offline");
          return;
        }
        if (response.ok) {
          // The answer is kept so the tricycle stays ticked off today. The photo is not.
          await putQueued({ ...row, photo: undefined, state: "sent" });
          sentAny = true;
        } else {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          await putQueued({ ...row, state: "failed", error: body?.error ?? "This could not be saved." });
        }
        await reload();
      }
      setSync("idle");
    } finally {
      draining.current = false;
      await reload();
      if (sentAny) router.refresh();
    }
  }, [reload, router, userId]);

  useEffect(() => {
    void reload().then(drain);
    const retry = () => void drain();
    const timer = setInterval(retry, RETRY_MS);
    window.addEventListener("online", retry);
    document.addEventListener("visibilitychange", retry);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", retry);
      document.removeEventListener("visibilitychange", retry);
    };
  }, [drain, reload]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let active = true;
    navigator.serviceWorker
      .register("/sw.js")
      .then(() => navigator.serviceWorker.ready)
      .then((registration) => {
        if (!active) return;
        const urls = performance.getEntriesByType("resource").map((entry) => entry.name);
        registration.active?.postMessage({ type: "precache", urls });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const change = (id: string, patch: Partial<Answer>) =>
    setAnswers((all) => ({ ...all, [id]: { ...all[id], ...patch } }));

  async function save(item: TodayItem, answer: Answer) {
    const inspectedAt = new Date();
    try {
      await putQueued({
        clientId: crypto.randomUUID(),
        userId,
        tricycleId: item.tricycleId,
        code: item.code,
        operatorName: item.operatorName,
        washed: answer.washed!,
        stickerIntact: answer.stickerIntact!,
        note: answer.note?.trim() || undefined,
        photo: answer.photo,
        inspectedAt: inspectedAt.toISOString(),
        date: lagosToday(),
        state: "pending",
      });
    } catch {
      setStorageProblem(true);
      return;
    }
    setAnswers(({ [item.tricycleId]: _done, ...rest }) => rest);
    await reload();
    void drain();
  }

  function answer(item: TodayItem, patch: Pick<Answer, "washed" | "stickerIntact">) {
    const next = { ...answers[item.tricycleId], ...patch };
    if (next.washed === true && next.stickerIntact === true) {
      void save(item, next);
    } else {
      change(item.tricycleId, patch);
    }
  }

  async function addPhoto(id: string, file: File | undefined) {
    if (!file) return;
    change(id, { problem: undefined });
    try {
      change(id, { photo: await compressPhoto(file) });
    } catch {
      change(id, { photo: undefined, problem: "That photo could not be read. Take it again." });
    }
  }

  const mine = queue.filter((row) => row.userId === userId);
  const waiting = mine.filter((row) => row.state === "pending");
  const failed = mine.filter((row) => row.state === "failed");
  const others = queue.filter((row) => row.userId !== userId && row.state === "pending").length;
  const stale = today !== date;

  const local = new Map(
    queue.filter((row) => row.state !== "failed" && row.date === today).map((row) => [row.tricycleId, row]),
  );
  const isDone = (item: TodayItem) => local.has(item.tricycleId) || (!stale && item.washed !== null);
  const term = search.trim().toLowerCase();
  const todo = items
    .filter((item) => !isDone(item))
    .filter(
      (item) =>
        !term || [item.code, item.registration, item.operatorName].some((value) => value.toLowerCase().includes(term)),
    );
  const done = items.filter(isDone);

  return (
    <div className="space-y-4">
      <p className="text-muted">
        <strong className="text-ink">{items.length - done.length}</strong> left, {done.length} done
      </p>

      {sync === "offline" ? (
        <p role="status" className="flex items-center gap-2 rounded-lg bg-gold-wash px-3 py-2 font-medium">
          <CloudOff size={18} aria-hidden /> No connection. Keep inspecting. {waiting.length} saved on this phone.
        </p>
      ) : waiting.length > 0 ? (
        <p role="status" className="rounded-lg bg-gold-wash px-3 py-2 font-medium">
          Sending {waiting.length}…
        </p>
      ) : null}
      {sync === "login" ? (
        <p role="alert" className="rounded-lg bg-danger-wash px-3 py-2 font-medium text-danger">
          Your login has ended. <a href="/login" className="underline">Log in again</a>. Your inspections are safe on this phone.
        </p>
      ) : null}
      {stale ? (
        <p role="status" className="rounded-lg bg-gold-wash px-3 py-2 font-medium">
          This list was saved on an earlier day. It will update when you have signal.
        </p>
      ) : null}
      {storageProblem ? (
        <p role="alert" className="rounded-lg bg-danger-wash px-3 py-2 font-medium text-danger">
          This phone is out of space, so that inspection was not saved.
        </p>
      ) : null}
      {others > 0 ? (
        <p className="rounded-lg bg-gold-wash px-3 py-2 text-sm">
          {others} inspection(s) from another login are waiting. They send when that person logs in.
        </p>
      ) : null}

      {failed.map((row) => (
        <div key={row.clientId} role="alert" className="rounded-xl border border-danger bg-danger-wash p-3">
          <div className="font-bold">{row.code} was not saved</div>
          <p className="text-sm">{row.error}</p>
          <button
            type="button"
            className="mt-2 min-h-11 rounded-lg border border-line bg-card px-4 font-semibold"
            onClick={() => void removeQueued(row.clientId).then(reload)}
          >
            Dismiss
          </button>
        </div>
      ))}

      <input
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Find code, plate or operator"
        aria-label="Find a tricycle"
        className="min-h-12 w-full rounded-lg border border-line bg-card px-3 text-base"
      />

      {items.length === 0 ? (
        <p className="rounded-xl border border-line bg-card p-4 text-muted">No tricycles are out with operators.</p>
      ) : todo.length === 0 && !term ? (
        <p className="rounded-xl bg-ok-wash p-4 font-semibold text-ok">Every tricycle has been inspected today.</p>
      ) : (
        <ul className="space-y-3">
          {todo.map((item) => {
            const current = answers[item.tricycleId] ?? {};
            const failing = current.washed === false || current.stickerIntact === false;
            const complete = current.washed !== undefined && current.stickerIntact !== undefined;
            return (
              <li key={item.tricycleId} className="rounded-xl border border-line bg-card p-4">
                <div className="mb-3">
                  <div className="text-lg font-bold">{item.code}</div>
                  <div className="text-sm text-muted">
                    {item.registration} · {item.operatorName}
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <YesNo label="Washed and polished?" value={current.washed} onChange={(value) => answer(item, { washed: value })} />
                  <YesNo label="Company sticker on?" value={current.stickerIntact} onChange={(value) => answer(item, { stickerIntact: value })} />
                </div>
                {failing ? (
                  <div className="mt-3 space-y-3 border-t border-line pt-3">
                    <label className="block font-medium">
                      Photo of the problem
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="mt-1 block w-full rounded-lg border border-line p-2 text-base"
                        onChange={(event) => void addPhoto(item.tricycleId, event.target.files?.[0])}
                      />
                    </label>
                    {current.photo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={current.photo} alt="Taken" className="max-h-40 rounded-lg" />
                    ) : null}
                    {current.problem ? <p className="text-sm font-medium text-danger">{current.problem}</p> : null}
                    <label className="block font-medium">
                      Note (optional)
                      <input
                        value={current.note ?? ""}
                        maxLength={500}
                        onChange={(event) => change(item.tricycleId, { note: event.target.value })}
                        className="mt-1 min-h-11 w-full rounded-lg border border-line px-3 text-base"
                      />
                    </label>
                    <button
                      type="button"
                      disabled={!complete || !current.photo}
                      onClick={() => void save(item, current)}
                      className="min-h-12 w-full rounded-lg bg-ink px-4 font-semibold text-gold-light disabled:opacity-50"
                    >
                      {!complete ? "Answer both questions" : !current.photo ? "Add a photo to save" : "Save and report"}
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {done.length > 0 ? (
        <section>
          <h2 className="mb-2 font-bold">Done today</h2>
          <ul className="divide-y divide-line rounded-xl border border-line bg-card">
            {done.map((item) => {
              const row = local.get(item.tricycleId);
              const washed = row ? row.washed : item.washed!;
              const sticker = row ? row.stickerIntact : item.stickerIntact!;
              return (
                <li key={item.tricycleId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <span className="font-semibold">
                    {item.code}
                    {row?.state === "pending" ? <span className="ml-2 text-sm font-normal text-muted">waiting to send</span> : null}
                  </span>
                  <span className="flex gap-3">
                    <Result good={washed} label="Clean" />
                    <Result good={sticker} label="Sticker" />
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
