/**
 * GET  /api/leaderboard — the ranked board (every completed season, ranked).
 * POST /api/leaderboard — add a completed run.
 *
 * Server-only. Every failure is turned into a JSON body the UI can render as a
 * friendly state: nowhere to store the run is `connected: false`, never a 500
 * with a stack trace.
 */
import { createFileRoute } from "@tanstack/react-router";

import { readBoard, submitRun, callerKey } from "~/server/leaderboard";
import { corsPreflight, withCors } from "~/server/cors";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/**
 * Every answer, with the app-store build's cross-origin allowance attached when
 * (and only when) the caller is the app itself. A web caller gets the identical
 * response object back, byte for byte — src/server/cors.ts holds the rule.
 */
const reply = (request: Request, body: unknown, status = 200): Response =>
  withCors(request, json(body, status));

/** Error codes → something a player can read. */
const MESSAGES: Record<string, string> = {
  invalid_name: "Pick a display name between 3 and 16 characters.",
  invalid_record: "That record doesn't look like a real 17-game season.",
  invalid_lineup: "That line-up isn't a complete 11-man roster.",
  invalid_player:
    "One of those picks isn't a real player from that team and era — ratings are taken from the player pool.",
  duplicate_player: "The same player can't fill two slots in one line-up.",
  invalid_body: "Something went wrong sending that run. Try again.",
  rate_limited: "That's a lot of runs at once — try again in a few minutes.",
  not_connected: "The board can't store runs right now — your run is still saved on this device.",
  server_error: "The leaderboard is having a moment — your run is still saved on this device.",
};

export const Route = createFileRoute("/api/leaderboard")({
  server: {
    handlers: {
      GET: async ({ request }): Promise<Response> => {
        try {
          return reply(request, await readBoard());
        } catch {
          return reply(request, { connected: false, total: 0, entries: [] });
        }
      },

      POST: async ({ request }): Promise<Response> => {
        try {
          let payload: unknown;
          try {
            payload = await request.json();
          } catch {
            return reply(request, { ok: false, error: "invalid_body", message: MESSAGES.invalid_body }, 400);
          }

          const outcome = await submitRun(payload, callerKey(request));
          if (!outcome.ok) {
            const status = outcome.error === "rate_limited" ? 429 : outcome.error === "not_connected" ? 503 : 400;
            return reply(
              request,
              {
                ok: false,
                error: outcome.error,
                message: MESSAGES[outcome.error] ?? MESSAGES.server_error,
              },
              status,
            );
          }
          return reply(request, {
            ok: true,
            entry: outcome.entry,
            rank: outcome.rank,
            total: outcome.total,
            // The players-board standing after this season, or null when the
            // rating could not be written. The run is on the board either way.
            player: outcome.player,
          });
        } catch {
          return reply(request, { ok: false, error: "server_error", message: MESSAGES.server_error }, 500);
        }
      },

      // The app's preflight: its origin is not this site's, so the JSON POST
      // above needs an explicit allowance before the browser will send it.
      // Only the app's own origins get one (src/server/cors.ts).
      OPTIONS: async ({ request }): Promise<Response> => corsPreflight(request),
    },
  },
});
