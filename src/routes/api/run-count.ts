/**
 * POST /api/run-count — ONE finished season, counted, with nothing attached.
 *
 * WHY IT EXISTS. A free run used to leave no trace at all: posting to the board
 * needs the $4.99 unlock and /profile is device-local, so "did anyone actually
 * play?" could only be answered by someone paying. The owner hands the game to
 * people they know and needs the honest answer back. This is it.
 *
 * THE WHOLE REQUEST IS ONE BOOLEAN. `{ "first": true | false }` — "was this the
 * first season this browser has ever finished?" — which the client can only
 * answer from its own storage (src/lib/run-count.ts). No device token, not even
 * hashed; no cookie; no name; no IP address read, hashed or stored; no user
 * agent; no id of any kind. The counters themselves are in
 * src/lib/run-stats.ts, and the readout is GET /api/stats.
 *
 * IT IS SENT FOR EVERY FINISHED SEASON, PAID OR NOT: the free first run is the
 * single most interesting number we have, so this is deliberately NOT gated on
 * the unlock, not gated on posting to the board, and not gated on the posting
 * opt-out (which is about a display name being public, and this request carries
 * no name).
 *
 * SPAM IS A REAL, ACCEPTED LIMIT — chosen mitigations, none of which identifies
 * a caller, and what each does NOT stop:
 *   1. Shape check. POST only; `content-type: application/json` required; body
 *      at most 200 bytes, checked against `content-length` before it is read and
 *      again after; the parsed body must be a JSON object with exactly one own
 *      key, `first`, holding a boolean. Anything else is 400 and is not counted.
 *      A hostile *web page* cannot quietly use a visitor's browser to inflate the
 *      count, because a cross-site JSON POST needs a CORS preflight we never
 *      answer. It does NOT stop anyone willing to send an HTTP request by hand —
 *      that is the accepted cost of counting without identifiers.
 *   2. A per-process ceiling: at most 60 accepted counts per rolling minute, and
 *      at most 8 in flight at once. Excess is dropped with 429 and is not
 *      counted. This bounds a script to a slow drip and keeps a burst from
 *      costing the counter anything. It does NOT stop a determined attacker
 *      spreading requests over time, or hitting several processes if the site is
 *      ever scaled out; it does NOT distinguish them from real players, which is
 *      the point of having no identifiers at all.
 *   3. No IP address is read here — deliberately, even though posting a run does
 *      hash + window one (src/server/leaderboard.ts). The whole value of this
 *      number is that it is anonymous, so an identifier is the one thing it
 *      cannot buy its own protection with.
 *
 * WHAT IT COSTS A PLAYER: nothing. The client fires this and forgets it — no
 * retry, no waiting, no UI — so whether it lands in 5ms or not at all, the run is
 * already saved on the device (src/components/Game.tsx, src/lib/run-count.ts).
 * Offline play is untouched: the request simply fails and is swallowed.
 *
 * NOTHING HERE IS INVESTIGATED OR LOGGED. A bad request gets a status code and a
 * short error string; no caller detail is written anywhere, so there is nothing
 * to leak and nothing to subpoena.
 */
import { createFileRoute } from "@tanstack/react-router";

import { MAX_COUNT_BODY_BYTES, parseCountBody } from "~/lib/run-stats";
import { corsPreflight, withCors } from "~/server/cors";
import { recordFinishedRun } from "~/server/run-stats";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/**
 * Every answer, with the app-store build's cross-origin allowance attached when
 * (and only when) the caller is the app itself. The app's pages are local files,
 * so its one finished-season ping is a cross-origin JSON POST and needs the
 * allowance to be sent at all — the count would read zero from inside the app
 * otherwise. A web caller gets the identical response object back, byte for byte
 * (src/server/cors.ts).
 */
const reply = (request: Request, body: unknown, status = 200): Response =>
  withCors(request, json(body, status));

/**
 * The per-process ceiling (see the header). Module state on purpose: it is a
 * rate limit for one server process's lifetime, not a record of anybody. A
 * redeploy resets it, which is fine — it exists to blunt bursts, not to track.
 */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 60;
const MAX_IN_FLIGHT = 8;

let windowStartedAt = 0;
let windowCount = 0;
let inFlight = 0;

type Budget = "ok" | "rate_limited" | "busy";

/** Spend one unit of the ceiling, or say why not. */
const takeBudget = (): Budget => {
  const now = Date.now();
  if (now - windowStartedAt >= WINDOW_MS) {
    windowStartedAt = now;
    windowCount = 0;
  }
  if (inFlight >= MAX_IN_FLIGHT) return "busy";
  if (windowCount >= MAX_PER_WINDOW) return "rate_limited";
  windowCount += 1;
  return "ok";
};

const isJsonContentType = (request: Request): boolean =>
  (request.headers.get("content-type") ?? "").trim().toLowerCase().startsWith("application/json");

export const Route = createFileRoute("/api/run-count")({
  server: {
    handlers: {
      POST: async ({ request }): Promise<Response> => {
        try {
          // (1) The shape check, before anything is read or spent.
          if (!isJsonContentType(request)) {
            return reply(request, { ok: false, error: "invalid_type" }, 400);
          }
          const declared = Number(request.headers.get("content-length") ?? "0");
          if (Number.isFinite(declared) && declared > MAX_COUNT_BODY_BYTES) {
            return reply(request, { ok: false, error: "invalid_body" }, 413);
          }
          const raw = await request.text();
          const first = parseCountBody(raw);
          if (first === null) return reply(request, { ok: false, error: "invalid_body" }, 400);

          // (2) The ceiling, then the count itself.
          const budget = takeBudget();
          if (budget !== "ok") return reply(request, { ok: false, error: budget }, 429);

          inFlight += 1;
          try {
            const counters = await recordFinishedRun(first);
            if (!counters) {
              // Nowhere to write it. The player never sees this; the number is
              // simply not ours to count right now.
              return reply(request, { ok: false, error: "not_connected" }, 503);
            }
            return reply(request, { ok: true });
          } finally {
            inFlight -= 1;
          }
        } catch {
          return reply(request, { ok: false, error: "server_error" }, 500);
        }
      },

      // Read-only by construction, and honest about it: there is no way to write
      // a counter through a GET.
      GET: async ({ request }): Promise<Response> =>
        reply(request, { ok: false, error: "method_not_allowed" }, 405),

      // The app's preflight for the JSON POST above. Only the app's own origins
      // get an allowance (src/server/cors.ts) — a wildcard here would let any
      // page on the web inflate this counter from a visitor's browser.
      OPTIONS: async ({ request }): Promise<Response> => corsPreflight(request),
    },
  },
});
