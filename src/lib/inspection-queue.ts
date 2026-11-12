export type QueuedInspection = {
  clientId: string;
  userId: string;
  tricycleId: string;
  code: string;
  operatorName: string;
  washed: boolean;
  stickerIntact: boolean;
  note?: string;
  inspectedAt: string;
  /** The Lagos date of the inspection, so old entries can be cleared. */
  date: string;
  state: "pending" | "sent" | "failed";
  error?: string;
};

const DB = "jayngol-offline";
const STORE = "inspections";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "clientId" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = work(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const allQueued = () => run<QueuedInspection[]>("readonly", (store) => store.getAll());
export const putQueued = (item: QueuedInspection) => run("readwrite", (store) => store.put(item));
export const removeQueued = (clientId: string) => run("readwrite", (store) => store.delete(clientId));

const lagos = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Lagos",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export const lagosToday = () => lagos.format(new Date());
