/**
 * Gridiron Immortals — client side of the profile API.
 *
 * Same contract as `~/lib/board-api` and `~/lib/players-board-api`: every call
 * resolves to a value, nothing throws, and an unreachable server or a board with
 * nowhere to read from becomes `connected: false` so the page can say so instead
 * of showing an error. The only thing a device sends is its token — the seasons
 * come back, nothing is written.
 */
import { apiUrl } from "~/lib/api-base";
import { toStanding } from "~/lib/board-api";
import {
  NO_STORE_PROFILE,
  OFFLINE_PROFILE,
  type ProfileData,
  type ProfileSeason,
} from "~/lib/profile";

const toSeason = (raw: unknown): ProfileSeason | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const id = Number(row.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return {
    id,
    wins: Number(row.wins) || 0,
    losses: Number(row.losses) || 0,
    undefeated: row.undefeated === true,
    overall: Number(row.overall) || 0,
    lineup: Array.isArray(row.lineup) ? (row.lineup as ProfileSeason["lineup"]) : [],
    createdAt: typeof row.createdAt === "string" ? row.createdAt : new Date(0).toISOString(),
    rank: typeof row.rank === "number" && row.rank > 0 ? row.rank : null,
    total: Number(row.total) || 0,
  };
};

export const fetchProfile = async (token: string | null): Promise<ProfileData> => {
  // Server-side render has no network to be missing: render the shell, fetch on
  // the client. Never claim "offline" in the SSR markup.
  if (typeof window === "undefined") return NO_STORE_PROFILE;
  let response: Response;
  try {
    // The token goes in the BODY, never in the URL. A query string is written
    // down by every proxy and hosting log between the phone and the server, and
    // the device token is the one thing that keys this device's seasons — it
    // must not sit in a log line. Same shape as the run counter
    // (src/lib/run-count.ts): one small JSON object, POST, nothing returned but
    // JSON. `cache: "no-store"` is belt-and-braces on top of the route's own
    // Cache-Control header, so a response keyed to one device can never be
    // replayed to another.
    response = await fetch(apiUrl("/api/profile"), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ token: token ?? null }),
      cache: "no-store",
      credentials: "omit",
    });
  } catch {
    // fetch only rejects when the request could not be made: no network.
    return OFFLINE_PROFILE;
  }
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return NO_STORE_PROFILE;
    const data = body as Record<string, unknown>;
    if (data.connected !== true) return NO_STORE_PROFILE;
    const seasons = Array.isArray(data.seasons)
      ? data.seasons.map(toSeason).filter((season): season is ProfileSeason => season !== null)
      : [];
    return {
      connected: true,
      offline: false,
      player: toStanding(data.player),
      seasons,
      boardTotal: Number(data.boardTotal) || 0,
      attribution: typeof data.attribution === "string" ? data.attribution : "",
    };
  } catch {
    // Something answered, it just was not our board: not the device's fault.
    return NO_STORE_PROFILE;
  }
};
