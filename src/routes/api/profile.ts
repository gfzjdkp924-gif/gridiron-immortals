/**
 * POST /api/profile — one device's own seasons. Body: `{"token": "<device token>"}`.
 *
 * Server-only. The ONLY thing a caller sends is its device token, and the token
 * is only ever used to select the caller's OWN rows: it is shape-checked,
 * hashed once here (so no store is handed the token — src/server/player-key.ts),
 * and every query is keyed by that hash. There is no name or key parameter, so
 * this endpoint cannot read another player's profile.
 *
 * WHY POST AND NOT `GET /api/profile?token=…` (changed 2026-10-04). A query
 * string is part of the request line, so it is written down by anything that
 * keeps a request log — including the hosting platform's own logs, which our
 * code cannot read or change (`/privacy` says so). The device token is the one
 * thing that keys a device's seasons, so it is sent in the body instead: the
 * body is never logged by a standard request log, and a URL carrying no token
 * leaves nothing to leak. Same shape as the finished-season counter
 * (src/routes/api/run-count.ts): POST, `content-type: application/json`, one
 * small object, a short error string instead of a stack trace.
 *
 * NOT CACHED, EVER. Every response — success or failure — carries
 * `cache-control: no-store`, so a response keyed to one device can never be
 * stored by a browser, a proxy or a CDN and replayed to a different device. POST
 * responses are not cached by anything by default; the header makes it explicit
 * rather than assumed.
 *
 * Every failure becomes a JSON body the page renders as a friendly state:
 * nowhere to read from is `connected: false`, never a 500 with a stack trace.
 */
import { createFileRoute } from "@tanstack/react-router";

import { cleanDeviceToken } from "~/lib/player-rating";
import { corsPreflight, withCors } from "~/server/cors";
import { playerKeyOrNull } from "~/server/player-key";
import { readProfile } from "~/server/profile";

/** The request body is one short token: nothing legitimate comes close to this. */
const MAX_PROFILE_BODY_BYTES = 256;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

/**
 * Every answer, with the app-store build's cross-origin allowance attached when
 * (and only when) the caller is the app itself — the app's pages are local
 * files, so its profile request is cross-origin. A web caller gets the
 * identical response object back, byte for byte (src/server/cors.ts).
 */
const reply = (request: Request, body: unknown, status = 200): Response =>
  withCors(request, json(body, status));

const isJsonContentType = (request: Request): boolean =>
  (request.headers.get("content-type") ?? "").trim().toLowerCase().startsWith("application/json");

/** The shape every refusal answers with: a state the page already renders. */
const NOWHERE = { connected: false, offline: false, player: null, seasons: [], boardTotal: 0 };

/** `{"token": "…"}` — a missing or null token is fine (an unknown device). */
const parseProfileBody = (raw: string): { token: unknown } | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return { token: (parsed as Record<string, unknown>).token };
  } catch {
    return null;
  }
};

export const Route = createFileRoute("/api/profile")({
  server: {
    handlers: {
      POST: async ({ request }): Promise<Response> => {
        try {
          if (!isJsonContentType(request)) return reply(request, NOWHERE, 400);
          const declared = Number(request.headers.get("content-length") ?? "0");
          if (Number.isFinite(declared) && declared > MAX_PROFILE_BODY_BYTES) return reply(request, NOWHERE, 413);
          const raw = await request.text();
          if (raw.length > MAX_PROFILE_BODY_BYTES) return reply(request, NOWHERE, 413);
          const body = parseProfileBody(raw);
          if (body === null) return reply(request, NOWHERE, 400);
          const key = playerKeyOrNull(cleanDeviceToken(body.token));
          return reply(request, await readProfile(key));
        } catch {
          return reply(request, NOWHERE);
        }
      },
      /**
       * A stray `GET /api/profile?token=…` — an old cached client, a crawler, a
       * prefetcher. Answered explicitly, and never by reading the query string:
       * the token is not a URL parameter here, so a URL that carries one reads
       * nothing. The body is the same "nothing to read from" state the page
       * already knows how to render.
       */
      GET: async ({ request }): Promise<Response> => reply(request, NOWHERE, 405),

      // The app's preflight for the JSON POST above. Only the app's own origins
      // get an allowance (src/server/cors.ts).
      OPTIONS: async ({ request }): Promise<Response> => corsPreflight(request),
    },
  },
});
