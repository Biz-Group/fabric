const CACHE_PREFIX = "fabric-pwa";
const STATIC_CACHE = `${CACHE_PREFIX}-static-v2`;

const STATIC_ASSET_PATHS = [
  "/manifest.webmanifest",
  "/fabric-icon.ico",
  "/fabric-icon-black.ico",
  "/pwa/apple-touch-icon.png",
  "/pwa/fabric-icon-192.png",
  "/pwa/fabric-icon-512.png",
  "/pwa/fabric-maskable-192.png",
  "/pwa/fabric-maskable-512.png",
];

const OFFLINE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#11161C" />
    <title>Fabric. offline</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f7f5f0;
        color: #11161c;
      }
      body {
        min-height: 100vh;
        margin: 0;
        display: grid;
        place-items: center;
        padding: 24px;
      }
      main {
        max-width: 420px;
      }
      h1 {
        margin: 0 0 12px;
        font-size: 32px;
        line-height: 1;
        letter-spacing: 0;
      }
      p {
        margin: 0;
        color: #5a6878;
        font-size: 15px;
        line-height: 1.5;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          background: #11161c;
          color: #fcfbf8;
        }
        p {
          color: #d8e1e8;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Fabric.</h1>
      <p>You are offline. Reconnect to continue working with your workspace.</p>
    </main>
  </body>
</html>`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) =>
        Promise.allSettled(
          STATIC_ASSET_PATHS.map((assetPath) => cache.add(assetPath)),
        ),
      )
      .catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== STATIC_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(OFFLINE_HTML, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }),
      ),
    );
    return;
  }

  // Never cache Next.js application chunks here. In development, Turbopack can
  // reuse a chunk URL for a different module graph; in production, Next.js
  // already gives immutable build assets content-addressed cache headers.
  if (STATIC_ASSET_PATHS.includes(url.pathname)) {
    event.respondWith(cacheFirst(request));
  }
});

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    cache.put(request, response.clone());
  }
  return response;
}
