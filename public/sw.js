/*
 * Gridiron Immortals — service worker.
 *
 * Hand-written on purpose: the app ships no client index.html for
 * vite-plugin-pwa to inject into (TanStack Start renders the shell on the
 * server), and the offline rules here are simple enough to state outright.
 *
 * The rules, in full:
 *   1. Only GET, only this origin. Everything else is left alone.
 *   2. /api/* is NEVER intercepted. The boards must fail honestly offline
 *      (they show "you're offline"), and a cached API response would be a lie.
 *   3. Navigations are network-first, falling back to the cached "/" shell so
 *      the client router can render any route offline. The URL is never
 *      rewritten: a route reached with a query string still carries that query
 *      string into the router offline, which is what a page loaded from a link
 *      with parameters needs.
 *   4. /assets/* (hashed build output) and the icons/manifest are cache-first —
 *      they never change under a given URL.
 *
 * Bump VERSION when an icon, the shell rule or the manifest's own copy changes:
 * the old caches are dropped on activate, and assets are re-fetched from the
 * network. (The manifest is in PRECACHE and cache-first, so a copy change there
 * would otherwise never reach a device that already installed the game — hence
 * v2, which carries the spin-on-every-pick description and the .com address.)
 */
const VERSION = "v2";
const SHELL_CACHE = `gridiron-shell-${VERSION}`;
const ASSET_CACHE = `gridiron-assets-${VERSION}`;
const OWNED_CACHES = [SHELL_CACHE, ASSET_CACHE];

const SHELL_URL = "/";
const MANIFEST_URL = "/manifest.webmanifest";
const API_PREFIX = "/api/";

/** Cached at install so a first-visit-then-offline device still gets an app. */
const PRECACHE = [
  SHELL_URL,
  MANIFEST_URL,
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-512-maskable.png",
  "/apple-touch-icon-180.png",
];

const ICON_PATHS = new Set([
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-512-maskable.png",
  "/apple-touch-icon-180.png",
]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // One unreachable file must not fail the whole install.
      await Promise.all(
        PRECACHE.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: "reload" }));
          } catch {
            /* offline or missing: the runtime handlers cover it later */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("gridiron-") && !OWNED_CACHES.includes(key))
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

const offlineShell = () =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Gridiron Immortals</title>` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<style>body{margin:0;background:#070c17;color:#e2e8f0;font:16px/1.5 system-ui,sans-serif;` +
      `display:grid;place-items:center;min-height:100vh;padding:24px;text-align:center}</style></head>` +
      `<body><div><h1 style="margin:0 0 8px">You&rsquo;re offline</h1>` +
      `<p style="margin:0;color:#94a3b8">This page has not been saved for offline play yet. ` +
      `Reconnect once, then the game works with no network at all.</p></div></body></html>`,
    { status: 503, headers: { "content-type": "text/html; charset=utf-8" } },
  );

/** Network first; the cached shell is the fallback for any route. */
async function navigationResponse(request) {
  const { pathname } = new URL(request.url);
  try {
    const response = await fetch(request);
    if (!response || !response.ok) throw new Error(`status ${String(response?.status ?? 0)}`);
    // Only the bare shell is stored: a real route keeps rendering through it,
    // and a page carrying a query string (a checkout return) is never cached.
    if (pathname === SHELL_URL) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(SHELL_URL, response.clone());
    }
    return response;
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    const shell = await cache.match(SHELL_URL);
    return shell ?? offlineShell();
  }
}

async function cacheFirstResponse(request, cacheName) {
  const cache = await caches.open(cacheName);
  // ignoreSearch stays false: the key is the whole URL, query string included.
  const hit = await cache.match(request, { ignoreSearch: false });
  if (hit) return hit;
  try {
    const response = await fetch(request);
    if (response && response.ok && response.type === "basic") {
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response("", { status: 504, statusText: "offline" });
  }
}

async function networkFirstResponse(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (!response || !response.ok) throw new Error(`status ${String(response?.status ?? 0)}`);
    if (response.type === "basic") await cache.put(request, response.clone());
    return response;
  } catch {
    const hit = await cache.match(request, { ignoreSearch: false });
    return hit ?? new Response("", { status: 504, statusText: "offline" });
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(API_PREFIX)) return;

  if (request.mode === "navigate") {
    event.respondWith(navigationResponse(request));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirstResponse(request, ASSET_CACHE));
    return;
  }
  if (ICON_PATHS.has(url.pathname)) {
    event.respondWith(cacheFirstResponse(request, SHELL_CACHE));
    return;
  }
  if (url.pathname === MANIFEST_URL) {
    event.respondWith(networkFirstResponse(request, SHELL_CACHE));
  }
});
