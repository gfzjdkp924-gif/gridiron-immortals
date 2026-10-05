/**
 * Gridiron Immortals — players board server logic (SERVER ONLY).
 *
 * Import this from a `createServerFn` handler or an `src/routes/api/*` route,
 * never from a component. Like the run board's server module, every exported
 * function swallows database failures and reports them as data
 * (`connected: false`) so a missing or unreachable database can never break the
 * game loop or leak a raw driver error into the UI.
 *
 * TRUST: `recordSeason` takes the submission the run board has ALREADY
 * validated — record legal (0..17 summing to 17), undefeated derived, overall
 * recomputed from the pool ratings carried on the lineup. It computes this
 * season's score from those numbers and hands the store one row's worth of
 * arithmetic. No rating, delta, season count or record is ever read from a
 * request body.
 *
 * TWO STORES, ONE CONTRACT: a USABLE connection string wins; with none — or with
 * one that cannot connect — the same contract is served from the file-backed
 * store (src/server/file-board.ts). See src/server/store-choice.ts.
 */
import { sql } from "~/db";
import { SEASON_GAMES } from "~/lib/rating";
import { fileReadPlayersBoard, fileRecordSeason } from "~/server/file-board";
import { notePostgresFailure, postgresAnswers } from "~/server/store-choice";
import {
  MAX_PLAYERS,
  MIN_SEASONS,
  TIERS,
  mapStandingRow,
  nextTier,
  scoreSeason,
  type PlayerRow,
  type PlayerStanding,
  type PlayersBoardData,
  type SeasonOutcome,
} from "~/lib/player-rating";
import {
  COUNT_IDENTITIES_SQL,
  COUNT_PLAYERS_SQL,
  PLAYERS_SCHEMA_STATEMENTS,
  PLAYER_BY_TOKEN_SQL,
  PLAYER_RANK_SQL,
  RANKED_PLAYERS_SQL,
  UPSERT_SEASON_SQL,
} from "~/lib/players-sql";

export type { PlayersBoardData, PlayerStanding };

/* ------------------------------------------------------------------ schema */

let schemaReady: Promise<void> | null = null;

/**
 * Same contract as the run board's schema step: idempotent, memoised on
 * success, memo cleared on failure so a database that comes up later starts
 * working without a redeploy.
 */
const ensurePlayerSchema = async (): Promise<void> => {
  if (!schemaReady) {
    schemaReady = (async () => {
      const db = sql();
      for (const statement of PLAYERS_SCHEMA_STATEMENTS) await db.query(statement, []);
    })().catch((error: unknown) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
};

const message = (error: unknown): string =>
  error instanceof Error ? error.message : "unknown database error";

const rows = async <T>(text: string, params: unknown[]): Promise<T[]> => {
  const result: unknown = await sql().query(text, params);
  return (Array.isArray(result) ? result : []) as T[];
};

/* ------------------------------------------------------------------ reads */

/** Finish a mapped row into the standing the UI shows. */
const standingFrom = (
  mapped: ReturnType<typeof mapStandingRow>,
  rank: number | null,
): PlayerStanding => {
  const qualified = mapped.seasons >= MIN_SEASONS;
  return {
    ...mapped,
    qualified,
    rank: qualified ? rank : null,
    seasonsToQualify: Math.max(0, MIN_SEASONS - mapped.seasons),
    nextTier: nextTier(mapped.rating),
  };
};

const rankOf = async (token: string): Promise<number | null> => {
  const found = await rows<{ rank: number }>(PLAYER_RANK_SQL, [token, MIN_SEASONS]);
  const rank = Number(found[0]?.rank ?? 0);
  return rank > 0 ? rank : null;
};

/**
 * The players board: the top MAX_PLAYERS ranked identities, the totals, the
 * published tier table, and — when the caller sends its device token — that
 * identity's own standing even if it has not cleared the seasons gate yet.
 */
export async function readPlayersBoard(token: string | null = null): Promise<PlayersBoardData> {
  // Same rule as the run board: a USABLE connection string wins, and with none —
  // or with one that cannot connect — the file-backed store answers, reporting
  // its own "not connected" only when it has nowhere to keep the tally.
  if (!(await postgresAnswers(ensurePlayerSchema))) return fileReadPlayersBoard(token);
  try {
    await ensurePlayerSchema();
    const board = await rows<Record<string, unknown>>(RANKED_PLAYERS_SQL, [MAX_PLAYERS, MIN_SEASONS]);
    const totals = await rows<{ total: number }>(COUNT_PLAYERS_SQL, [MIN_SEASONS]);
    const identities = await rows<{ total: number }>(COUNT_IDENTITIES_SQL, []);

    const entries: PlayerRow[] = board.map((row, index) => {
      const mapped = mapStandingRow(row);
      const device = typeof row.device_token === "string" ? row.device_token : "";
      return {
        rank: index + 1,
        ...mapped,
        bestOverall: Number((row as Record<string, unknown>).best_overall) || 0,
        you: token !== null && device === token,
      };
    });

    let you: PlayerStanding | null = null;
    if (token !== null) {
      const mine = await rows<Record<string, unknown>>(PLAYER_BY_TOKEN_SQL, [token]);
      const row = mine[0];
      if (row) you = standingFrom(mapStandingRow(row), await rankOf(token));
    }

    return {
      connected: true,
      total: Number(totals[0]?.total ?? 0),
      identities: Number(identities[0]?.total ?? 0),
      minSeasons: MIN_SEASONS,
      tiers: TIERS,
      entries,
      you,
    };
  } catch (error: unknown) {
    console.error("[players] read failed:", message(error));
    // Database gone mid-request: the file-backed board answers from here.
    notePostgresFailure();
    return fileReadPlayersBoard(token);
  }
}

/* ------------------------------------------------------------------ write */

/**
 * Fold ONE completed season into the caller's rating.
 *
 * Returns the identity's new standing, or null when the rating could not be
 * written. Null is NOT a failure of the run: `submitRun` calls this after the
 * run row is safely stored, and a rating hiccup must never turn a good
 * submission into an error for the player.
 */
export async function recordSeason(
  outcome: SeasonOutcome,
  token: string | null,
  name: string,
): Promise<PlayerStanding | null> {
  if (token === null) return null;
  // No usable connection string: the same fold, done on the file-backed document.
  if (!(await postgresAnswers(ensurePlayerSchema))) return fileRecordSeason(outcome, token, name);
  try {
    await ensurePlayerSchema();
    const { score } = scoreSeason(outcome);
    // $1..$7, in the order UPSERT_SEASON_SQL declares them: token, name, this
    // season's score, wins, losses, the lineup's overall, and the 17-0 flag.
    const written = await rows<Record<string, unknown>>(UPSERT_SEASON_SQL, [
      token,
      name,
      score,
      outcome.wins,
      SEASON_GAMES - outcome.wins,
      outcome.overall,
      outcome.wins >= SEASON_GAMES ? 1 : 0,
    ]);
    const row = written[0];
    if (!row) return null;
    const mapped = mapStandingRow(row);
    return standingFrom(mapped, mapped.seasons >= MIN_SEASONS ? await rankOf(token) : null);
  } catch (error: unknown) {
    console.error("[players] season update failed:", message(error));
    // Database gone mid-request: fold the season into the file-backed document
    // instead, so a rating is still credited to the device that earned it.
    notePostgresFailure();
    return fileRecordSeason(outcome, token, name);
  }
}
