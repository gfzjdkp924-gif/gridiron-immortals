/**
 * Gridiron Immortals — client side of the leaderboard API.
 *
 * Every call resolves to a value; nothing throws and nothing surfaces a raw
 * error. If the board is unreachable the game simply reports that the board
 * isn't connected and the device-local history keeps working.
 */
import { apiUrl } from "~/lib/api-base";
import type { BoardData, LeaderboardEntry, LineupPick } from "~/lib/leaderboard";
import type { PlayerStanding } from "~/lib/player-rating";

/** The server answered: it has nowhere to store a run (no database, no writable store). */
const NO_DATABASE_BOARD: BoardData = { connected: false, offline: false, total: 0, entries: [] };

/**
 * The request never left the device — no network at all. Marked, so the board
 * can say "you're offline" instead of blaming its own storage.
 */
const NETWORK_DOWN_BOARD: BoardData = { connected: false, offline: true, total: 0, entries: [] };

export const OFF_BOARD_MESSAGE =
  "The board can't store runs right now — your run is still saved on this device.";

/**
 * The request never left the device, which is a different thing from a server
 * with nowhere to store a run. Saying "not connected yet" while the player is on
 * a train would blame the board for the phone's connection.
 */
export const OFFLINE_MESSAGE =
  "You're offline — your run is saved on this device and can go on the board when you're back online.";

const isLineup = (value: unknown): value is LineupPick[] => Array.isArray(value);

const toEntry = (raw: unknown): LeaderboardEntry | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.name !== "string") return null;
  return {
    id: Number(row.id) || 0,
    name: row.name,
    wins: Number(row.wins) || 0,
    losses: Number(row.losses) || 0,
    undefeated: Boolean(row.undefeated),
    overall: Number(row.overall) || 0,
    lineup: isLineup(row.lineup) ? row.lineup : [],
    createdAt: typeof row.createdAt === "string" ? row.createdAt : new Date(0).toISOString(),
  };
};

export const fetchBoard = async (): Promise<BoardData> => {
  // Server-side render has no network of its own to be missing: it renders the
  // shell and the client fetches. Never claim "offline" in the SSR markup.
  if (typeof window === "undefined") return NO_DATABASE_BOARD;
  let response: Response;
  try {
    // The address comes from src/lib/api-base.ts: relative in the web build,
    // the game's own published origin in the app build. Same call either way.
    response = await fetch(apiUrl("/api/leaderboard"), {
      headers: { accept: "application/json" },
    });
  } catch {
    // fetch only rejects when the request could not be made: no network.
    return NETWORK_DOWN_BOARD;
  }
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return NO_DATABASE_BOARD;
    const data = body as Record<string, unknown>;
    if (data.connected !== true) return NO_DATABASE_BOARD;
    const entries = Array.isArray(data.entries)
      ? data.entries.map(toEntry).filter((entry): entry is LeaderboardEntry => entry !== null)
      : [];
    return { connected: true, offline: false, total: Number(data.total) || entries.length, entries };
  } catch {
    // Something answered, it just wasn't our board: not the device's fault.
    return NO_DATABASE_BOARD;
  }
};

export type SubmitOutcome =
  | { ok: true; rank: number; total: number; player: PlayerStanding | null }
  | { ok: false; error: string; message: string };

/**
 * Post a completed season. The body carries the device token (the identity the
 * rating is credited to) and nothing else that could influence a rating: the
 * server re-derives the record, the undefeated flag, the overall rating and this
 * season's score from the lineup it validates against the pool.
 */
export const submitToBoard = async (payload: {
  name: string;
  wins: number;
  losses: number;
  undefeated: boolean;
  lineup: LineupPick[];
  deviceToken: string | null;
}): Promise<SubmitOutcome> => {
  let response: Response;
  try {
    response = await fetch(apiUrl("/api/leaderboard"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // The request never left the device: say so, rather than blaming the board.
    return { ok: false, error: "offline", message: OFFLINE_MESSAGE };
  }
  const body: unknown = await response.json().catch(() => null);
  const data = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (data.ok === true) {
    return {
      ok: true,
      rank: Number(data.rank) || 0,
      total: Number(data.total) || 0,
      player: toStanding(data.player),
    };
  }
  return {
    ok: false,
    error: typeof data.error === "string" ? data.error : "server_error",
    message: typeof data.message === "string" ? data.message : OFF_BOARD_MESSAGE,
  };
};

/**
 * A standing as the server sends it. Defensive on purpose: this is a network
 * payload, so a malformed one becomes `null` (no rating panel) rather than a
 * crash in the render.
 */
export const toStanding = (raw: unknown): PlayerStanding | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.name !== "string" || typeof row.tier !== "string") return null;
  return {
    name: row.name,
    rating: Number(row.rating) || 0,
    tier: row.tier as PlayerStanding["tier"],
    seasons: Number(row.seasons) || 0,
    wins: Number(row.wins) || 0,
    losses: Number(row.losses) || 0,
    bestWins: Number(row.bestWins) || 0,
    bestLosses: Number(row.bestLosses) || 0,
    perfectSeasons: Number(row.perfectSeasons) || 0,
    qualified: row.qualified === true,
    rank: typeof row.rank === "number" ? row.rank : null,
    seasonsToQualify: Number(row.seasonsToQualify) || 0,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : new Date(0).toISOString(),
    nextTier:
      typeof row.nextTier === "object" && row.nextTier !== null
        ? (row.nextTier as PlayerStanding["nextTier"])
        : null,
  };
};
