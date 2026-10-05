/**
 * GET /api/stats — the anonymous finished-season counters, and nothing else.
 *
 * WHAT COMES OUT (src/lib/run-stats.ts holds the definitions):
 *
 *   {
 *     "ok": true,
 *     "connected": true,
 *     "runsFinished": 12,          every finished season ever counted
 *     "firstRuns": 5,              of those, a device's FIRST finished season
 *     "byDay": { "2026-10-04": 7, … },        per UTC day, last 30 days
 *     "firstByDay": { "2026-10-04": 3, … },   the same, first seasons only
 *     "updatedAt": "2026-10-04T…Z",           when they last moved, or null
 *     "days": 30,                  how many days of tallies are kept
 *     "note": "…"                  one sentence saying what these are
 *   }
 *
 * Those numbers count RUNS, NEVER PEOPLE. There is no id, no name, no device
 * token, no address and no list of anything here — the endpoint cannot answer
 * "who played", because the store it reads does not hold the answer to that
 * question. It is safe to read aloud next to /privacy.
 *
 * READ-ONLY, PROVABLY. This handler only reads (`readRunStats` →
 * `readDocument`); there is no POST/PUT/PATCH/DELETE on this path, and no query
 * parameter changes what it returns. `GET /api/run-count` answers 405, and the
 * only way a counter ever moves is `POST /api/run-count`.
 *
 * WHEN THERE IS NOWHERE TO READ FROM it answers 503 with `connected: false`
 * rather than a page of zeros that would read like "nobody is playing". Zeros
 * and "I cannot see" are different answers, and this endpoint never confuses
 * them.
 *
 * `cache-control: no-store`, like every board response: a number that is right
 * only when it is current should never be cached anywhere.
 */
import { createFileRoute } from "@tanstack/react-router";

import { KEEP_DAYS } from "~/lib/run-stats";
import { readRunStats } from "~/server/run-stats";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/** One sentence, so the numbers cannot be read as anything they are not. */
const NOTE =
  "How many seasons have been finished on the game, counted in numbers only — no name, device, token, cookie or IP address is attached to any of them, so this counts runs and never people.";

export const Route = createFileRoute("/api/stats")({
  server: {
    handlers: {
      GET: async (): Promise<Response> => {
        try {
          const { connected, counters } = await readRunStats();
          if (!connected) {
            return json(
              {
                ok: false,
                connected: false,
                note: "the counters have nowhere to be read from right now — this is not a count of zero",
              },
              503,
            );
          }
          return json({
            ok: true,
            connected: true,
            runsFinished: counters.runsFinished,
            firstRuns: counters.firstRuns,
            byDay: counters.byDay,
            firstByDay: counters.firstByDay,
            updatedAt: counters.updatedAt,
            days: KEEP_DAYS,
            note: NOTE,
          });
        } catch {
          return json({ ok: false, connected: false, note: "the counters could not be read" }, 503);
        }
      },

      // Read-only: nothing writes a counter through this path.
      POST: async (): Promise<Response> => json({ ok: false, error: "method_not_allowed" }, 405),
    },
  },
});
