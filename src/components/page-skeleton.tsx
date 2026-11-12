/** A calm placeholder in the shape of a page, shown while it loads. */
export function PageSkeleton({ dark = false }: { dark?: boolean }) {
  const block = dark ? "bg-paper/10" : "bg-line/60";
  return (
    <div role="status" aria-live="polite" className="animate-pulse">
      <span className="sr-only">Loading…</span>
      <div className={`h-8 w-56 max-w-[70%] rounded-lg ${block}`} />
      <div className={`mt-2 h-4 w-80 max-w-[90%] rounded ${block}`} />
      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 rounded-2xl border border-line bg-card p-4 shadow-premium">
            <div className={`h-3 w-20 rounded ${block}`} />
            <div className={`mt-3 h-6 w-16 rounded ${block}`} />
          </div>
        ))}
      </div>
      <div className="mt-4 rounded-2xl border border-line bg-card p-4 shadow-premium sm:p-5">
        <div className={`h-5 w-40 rounded ${block}`} />
        <div className="mt-4 space-y-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <div className={`h-10 w-10 shrink-0 rounded-xl ${block}`} />
              <div className="flex-1 space-y-2">
                <div className={`h-3.5 w-1/2 rounded ${block}`} />
                <div className={`h-3 w-1/3 rounded ${block}`} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
