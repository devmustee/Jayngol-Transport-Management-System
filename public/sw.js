// Keeps the inspection screen openable with no signal. Only that page and the
// app's own files are stored. Nothing else passes through here.
const PAGES = "jayngol-pages-v1";
const FILES = "jayngol-files-v1";
const INSPECT = "/inspections";
const WAIT_MS = 4000;
const isLocal = self.location.hostname === "localhost";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const isAppFile = (url) =>
  url.origin === self.location.origin &&
  (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/brand/"));

const storable = (response) => response.ok && response.type === "basic" && !response.redirected;

async function precache(listed) {
  const page = await fetch(INSPECT, { credentials: "same-origin", cache: "no-store" });
  if (!storable(page)) return;
  const html = await page.clone().text();
  await (await caches.open(PAGES)).put(INSPECT, page);

  const found = [...html.matchAll(/\/_next\/static\/[^"'\\\s<>)]+/g)].map((match) => match[0]);
  const urls = [...new Set([...listed, ...found])]
    .map((value) => new URL(value, self.location.origin))
    .filter(isAppFile)
    .map((url) => url.href);

  const files = await caches.open(FILES);
  await Promise.all(
    urls.map(async (url) => {
      if (await files.match(url)) return;
      const response = await fetch(url).catch(() => null);
      if (response && storable(response)) await files.put(url, response);
    }),
  );
  const keep = new Set(urls);
  for (const request of await files.keys()) {
    if (!keep.has(request.url)) await files.delete(request);
  }
}

self.addEventListener("message", (event) => {
  if (event.origin && event.origin !== self.location.origin) return;
  if (event.data?.type === "precache" && Array.isArray(event.data.urls)) {
    event.waitUntil(precache(event.data.urls).catch(() => undefined));
  }
});

async function inspectPage(request) {
  const cache = await caches.open(PAGES);
  const network = fetch(request).then((response) => {
    if (storable(response)) cache.put(INSPECT, response.clone());
    return response;
  });
  const saved = await cache.match(INSPECT, { ignoreVary: true, ignoreSearch: true });
  if (!saved) return network;
  const slow = new Promise((resolve) => setTimeout(() => resolve(saved), WAIT_MS));
  return Promise.race([network.catch(() => saved), slow]);
}

async function appFile(request) {
  const cache = await caches.open(FILES);
  const saved = await cache.match(request, { ignoreVary: true });
  // File names change with each release, so a saved copy is always right.
  // On localhost they do not, so ask the dev server first.
  if (saved && !isLocal) return saved;
  try {
    const response = await fetch(request);
    if (storable(response)) cache.put(request, response.clone());
    return response;
  } catch (error) {
    if (saved) return saved;
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate" && url.pathname === INSPECT) {
    event.respondWith(inspectPage(request));
  } else if (isAppFile(url)) {
    event.respondWith(appFile(request));
  }
});
