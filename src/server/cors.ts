/**
 * Gridiron Immortals — CORS for the `/api/*` routes, so the bundled app can
 * reach the board, the players board, the profile and the run counter.
 *
 * WHY THIS EXISTS. The web build calls these routes from the same origin the
 * pages came from, so a browser never asks permission and no header is needed.
 * The app-store build is different: its pages are local files on the app's own
 * origin (`capacitor://localhost` on iOS, `https://localhost` on Android — see
 * src/lib/api-base.ts), so every call is cross-origin and the browser/webview
 * sends a preflight first for the JSON POSTs. Without an answer to that
 * preflight, and without an allowance on the reply, the app's boards and its
 * finished-run counter are dead inside the app the owner is about to ship.
 *
 * WHAT IT ALLOWS, EXACTLY. Three origins, written out, never a wildcard:
 *
 *   capacitor://localhost   iOS — the Capacitor webview's own origin
 *   https://localhost       Android — the Capacitor webview's own origin
 *   ionic://localhost       the older Capacitor/Cordova scheme on iOS
 *
 * A wildcard would be the one-line version, and it is the wrong line: it would
 * let ANY page on the internet post a season to the board from a visitor's
 * browser. The app's origins are a fixed, known, offline set, so they are named.
 *
 * HOW IT STAYS ADDITIVE. The allowance is only ever added when the request
 * carries one of those three origins. Every other caller — the site's own pages
 * (same-origin, and same-origin POSTs carry the site's origin, which is not in
 * the list), a curl with no `Origin`, a crawler, the platform's own health
 * checks — gets exactly the bytes it got before this file existed, unchanged.
 * Nothing here reads, sets or forwards a cookie: no credentials are involved, so
 * `access-control-allow-credentials` is deliberately absent.
 *
 * NOT A SECURITY BOUNDARY. This decides which origins a browser will let READ
 * these responses. It is not authentication and it does not pretend to be: the
 * board's own limits (name and shape checks, the caller-key rate window) and the
 * run counter's per-process ceiling are what bound them, and both are unchanged.
 */
export const APP_ORIGINS = [
  "capacitor://localhost",
  "https://localhost",
  "ionic://localhost",
] as const;

/**
 * The app's origins, as the strings a webview actually sends. Compared
 * case-insensitively (schemes and hosts are case-insensitive; a browser's own
 * `Origin` is lower-case, and a hand-written request is not going to be
 * answered differently for its capitalisation).
 */
const ALLOWED_ORIGINS = new Set(APP_ORIGINS.map((origin) => origin.toLowerCase()));

/** What the app is allowed to do with these routes: read the boards, post a run. */
const PREFLIGHT_METHODS = "GET, POST, OPTIONS";

/** What the app's requests actually carry — nothing else is ever sent. */
const PREFLIGHT_HEADERS = "content-type, accept";

/** Ten minutes: the app preflights rarely and this keeps it from asking every time. */
const PREFLIGHT_MAX_AGE = "600";

/**
 * The caller's origin, if it is one of the app's — otherwise `null`, which is
 * the whole answer for every web caller.
 *
 * The value is echoed EXACTLY as it arrived (trimmed) rather than rebuilt from
 * the list: a browser compares the header byte-for-byte with the origin it
 * asked from, so echoing the request's own string is the only version that
 * cannot mismatch.
 */
const appOrigin = (request: Request): string | null => {
  const header = request.headers.get("origin");
  if (header === null) return null;
  const origin = header.trim();
  return ALLOWED_ORIGINS.has(origin.toLowerCase()) ? origin : null;
};

/**
 * Add the allowance to a response, or hand back the very same response.
 *
 * A web caller gets the ORIGINAL object: same status, same headers, same body,
 * not a re-wrapped copy — so "nothing changed for the web" is structural rather
 * than something that has to be spot-checked. `vary: origin` is added only on
 * the app path, so a shared cache can never serve one origin's allowance to
 * another; the routes' own `cache-control: no-store` already forbids caching
 * these bodies at all.
 */
export const withCors = (request: Request, response: Response): Response => {
  const origin = appOrigin(request);
  if (origin === null) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.append("vary", "origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

/**
 * The preflight answer: `OPTIONS` on a route, from the app.
 *
 * 204 with the allowance for an app origin; 405 with no allowance for anyone
 * else, which is the honest way to say "this path is not a general-purpose
 * OPTIONS endpoint" and leaves a browser's own cross-site attempt blocked. No
 * body either way: there is nothing to say.
 */
export const corsPreflight = (request: Request): Response => {
  const origin = appOrigin(request);
  if (origin === null) {
    return new Response(null, { status: 405, headers: { allow: PREFLIGHT_METHODS } });
  }
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": PREFLIGHT_METHODS,
      "access-control-allow-headers": PREFLIGHT_HEADERS,
      "access-control-max-age": PREFLIGHT_MAX_AGE,
      vary: "origin",
    },
  });
};
