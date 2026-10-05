/**
 * Gridiron Immortals — the profile read (SERVER ONLY).
 *
 * WHAT IT ANSWERS: one device's own seasons, plus that device's standing on the
 * players board. Nothing else — the read is keyed by the ONE-WAY hash of the
 * caller's device token (src/server/player-key.ts), so a profile can only ever
 * be its own caller's. There is no parameter that names another player, which is
 * why there is no way to read someone else's profile through this endpoint.
 *
 * THE ATTRIBUTION RULE, which is the whole reason this module exists: a posted
 * season belongs to a player when the run's stored `playerKey` equals the hash of
 * the caller's device token. NOT when the names match. Names are 3–16 characters
 * and two phones may pick the same one — the players board already treats those
 * as two players, and a profile that matched on the name would hand one phone the
 * other's seasons. So a run with no key (posted before the key existed) is
 * attributed to nobody, and such a season is still shown to its player from the
 * device's own copy instead (see src/lib/profile.ts).
 *
 * SAME STORE RULE AS THE BOARDS: a USABLE Postgres connection wins; with none —
 * or with one that cannot connect — the file-backed store answers
 * (src/server/store-choice.ts, src/server/file-board.ts). Nothing here throws:
 * an unreachable store is `connected: false`, which the page renders as an
 * honest "the board can't be read right now" while the device's own seasons
 * still show.
 *
 * THE RATING IS NOT RECOMPUTED HERE. The standing comes from `readPlayersBoard`,
 * the players board's own reader, so the number and the band on a profile are the
 * same number and band the players board shows, by construction.
 */
import { sql } from "~/db";
import { mapBoardRow } from "~/lib/leaderboard";
import { COUNT_RUNS_SQL, RANKED_RUNS_BY_PLAYER_SQL } from "~/lib/leaderboard-sql";
import type { ProfileData, ProfileSeason } from "~/lib/profile";
import { PROFILE_ATTRIBUTION_FALLBACK } from "~/lib/profile";
import { fileReadPlayerSeasons } from "~/server/file-board";
import { boardsUseDatabase } from "~/server/leaderboard";
import { readPlayersBoard } from "~/server/player-board";
import { notePostgresFailure } from "~/server/store-choice";

const message = (error: unknown): string =>
  error instanceof Error ? error.message : "unknown database error";

/**
 * A profile shows the most recent seasons. The cap is generous — a
 * rate-limited device posting eight runs a ten-minute window is nowhere near it
 * — and it exists only so one very old device cannot make the page enormous.
 */
const MAX_PROFILE_SEASONS = 100;

/** Printed on the page, so the attribution rule is never a hidden behaviour. */
export const PROFILE_ATTRIBUTION = PROFILE_ATTRIBUTION_FALLBACK;

const rows = async <T>(text: string, params: unknown[]): Promise<T[]> => {
  const result: unknown = await sql().query(text, params);
  return (Array.isArray(result) ? result : []) as T[];
};

/**
 * One device's runs, with each one's rank on the whole board — or null when
 * there is nowhere to read from at all (the caller reports "not connected").
 */
const readBoardSeasons = async (
  key: string,
): Promise<{ seasons: ProfileSeason[]; total: number } | null> => {
  if (await boardsUseDatabase()) {
    try {
      const [found, totals] = await Promise.all([
        rows<Record<string, unknown>>(RANKED_RUNS_BY_PLAYER_SQL, [key]),
        rows<{ total: number }>(COUNT_RUNS_SQL, []),
      ]);
      const total = Number(totals[0]?.total ?? 0);
      const seasons: ProfileSeason[] = found.map((row) => {
        const entry = mapBoardRow(row);
        const rank = Number(row.rank) || 0;
        return {
          id: entry.id,
          wins: entry.wins,
          losses: entry.losses,
          undefeated: entry.undefeated,
          overall: entry.overall,
          lineup: entry.lineup,
          createdAt: entry.createdAt,
          rank: rank > 0 ? rank : null,
          total,
        };
      });
      return { seasons: seasons.slice(0, MAX_PROFILE_SEASONS), total };
    } catch (error: unknown) {
      console.error("[profile] read failed:", message(error));
      // The database went away mid-request: the file store answers from here, and
      // the next request re-probes rather than paying this failure again.
      notePostgresFailure();
      return fileReadPlayerSeasons(key);
    }
  }
  const file = await fileReadPlayerSeasons(key);
  return file === null ? null : { seasons: file.seasons.slice(0, MAX_PROFILE_SEASONS), total: file.total };
};

/**
 * The caller's own profile. `key` is the hashed device token (or null when the
 * request carried none — then nothing is attributable, which is honest rather
 * than an error).
 */
export async function readProfile(key: string | null): Promise<ProfileData> {
  const players = await readPlayersBoard(key);
  if (key === null) {
    return {
      connected: players.connected,
      player: null,
      seasons: [],
      boardTotal: 0,
      attribution: PROFILE_ATTRIBUTION,
    };
  }
  try {
    const board = await readBoardSeasons(key);
    return {
      connected: board !== null && players.connected,
      player: players.you,
      seasons: board?.seasons ?? [],
      boardTotal: board?.total ?? 0,
      attribution: PROFILE_ATTRIBUTION,
    };
  } catch (error: unknown) {
    // Nothing should reach here — the stores swallow their own failures — but an
    // unreadable profile is data, never a 500 with a stack trace.
    console.error("[profile] unexpected failure:", message(error));
    return {
      connected: false,
      player: players.you,
      seasons: [],
      boardTotal: 0,
      attribution: PROFILE_ATTRIBUTION,
    };
  }
}
