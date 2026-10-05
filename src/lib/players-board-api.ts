/**
 * Gridiron Immortals — client side of the players board API.
 *
 * Same contract as ~/lib/board-api: every call resolves to a value, nothing
 * throws, and an unreachable board or a missing database becomes
 * `connected: false` so the UI can show its "not connected" state instead of an
 * error. Nothing here ever sends a rating: the only thing a device contributes
 * is its token.
 */
import { apiUrl } from "~/lib/api-base";
import { toStanding } from "~/lib/board-api";
import { OFFLINE_PLAYERS, type PlayerRow, type PlayersBoardData } from "~/lib/player-rating";

const isRow = (raw: unknown): raw is PlayerRow =>
  typeof raw === "object" &&
  raw !== null &&
  typeof (raw as PlayerRow).name === "string" &&
  typeof (raw as PlayerRow).rating === "number";

/** The request never left the device: the same shape, marked as offline. */
const NETWORK_DOWN_PLAYERS: PlayersBoardData = { ...OFFLINE_PLAYERS, offline: true };

export const fetchPlayersBoard = async (token: string | null): Promise<PlayersBoardData> => {
  if (typeof window === "undefined") return OFFLINE_PLAYERS;
  let response: Response;
  try {
    // The token goes in the BODY, never in the URL — identical to
    // `~/lib/profile-api`. A query string is part of the request line, so it is
    // written down by every proxy and hosting log between the phone and the
    // server, and the device token is the one thing that keys this device's
    // rating — it must not sit in a log line. `cache: "no-store"` is
    // belt-and-braces on top of the route's own Cache-Control header, so a
    // response keyed to one device can never be replayed to another.
    response = await fetch(apiUrl("/api/players"), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ token: token ?? null }),
      cache: "no-store",
      credentials: "omit",
    });
  } catch {
    return NETWORK_DOWN_PLAYERS;
  }
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return OFFLINE_PLAYERS;
    const data = body as Record<string, unknown>;
    if (data.connected !== true) return OFFLINE_PLAYERS;
    const entries = Array.isArray(data.entries) ? data.entries.filter(isRow) : [];
    return {
      connected: true,
      offline: false,
      total: Number(data.total) || entries.length,
      identities: Number(data.identities) || 0,
      minSeasons: Number(data.minSeasons) || OFFLINE_PLAYERS.minSeasons,
      tiers: Array.isArray(data.tiers) ? (data.tiers as PlayersBoardData["tiers"]) : OFFLINE_PLAYERS.tiers,
      entries,
      // The caller's own standing, verified field by field like everything else
      // that arrives over the wire.
      you: toStanding(data.you),
    };
  } catch {
    return OFFLINE_PLAYERS;
  }
};
