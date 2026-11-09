import Link from "next/link";
import type { ReactNode } from "react";

const INPUT = "mt-1 min-h-11 w-full rounded-lg border border-line bg-card px-3 text-base";

function Choice({
  name,
  label,
  value,
  children,
}: {
  name: string;
  label: string;
  value?: string;
  children: ReactNode;
}) {
  return (
    <label className="font-medium">
      {label}
      <select name={name} defaultValue={value ?? ""} className={INPUT}>
        {children}
      </select>
    </label>
  );
}

/** A plain GET form, so a filtered list can be bookmarked or shared. */
export function HistoryFilters({
  clearHref,
  tricycles,
  items,
  showType,
  filter,
}: {
  clearHref: string;
  tricycles: { id: string; code: string }[];
  items?: { id: string; name: string }[];
  showType?: boolean;
  filter: { tricycleId?: string; itemId?: string; type?: string; from?: string; to?: string };
}) {
  return (
    <form className="mb-4 grid grid-cols-2 items-end gap-3 sm:grid-cols-3">
      <div className="col-span-2 sm:col-span-1">
        <Choice name="tricycleId" label="Tricycle" value={filter.tricycleId}>
          <option value="">All tricycles</option>
          {tricycles.map((t) => <option key={t.id} value={t.id}>{t.code}</option>)}
        </Choice>
      </div>
      {items ? (
        <div className="col-span-2 sm:col-span-1">
          <Choice name="itemId" label="Item" value={filter.itemId}>
            <option value="">All items</option>
            {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </Choice>
        </div>
      ) : null}
      {showType ? (
        <div className="col-span-2 sm:col-span-1">
          <Choice name="type" label="Type" value={filter.type}>
            <option value="">Services and repairs</option>
            <option value="service">Services</option>
            <option value="maintenance">Repairs</option>
          </Choice>
        </div>
      ) : null}
      <label className="min-w-0 font-medium">
        From
        <input type="date" name="from" defaultValue={filter.from} className={INPUT} />
      </label>
      <label className="min-w-0 font-medium">
        To
        <input type="date" name="to" defaultValue={filter.to} className={INPUT} />
      </label>
      <div className="col-span-2 flex items-center gap-4 sm:col-span-1">
        <button className="min-h-11 rounded-lg bg-ink px-4 font-semibold text-gold-light">Show</button>
        <Link href={clearHref} className="font-medium text-gold-deep underline">Clear</Link>
      </div>
    </form>
  );
}
