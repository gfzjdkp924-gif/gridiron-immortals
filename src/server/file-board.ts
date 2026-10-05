/**
 * Gridiron Immortals — the boards, served from the file-backed store
 * (SERVER ONLY).
 *
 * This is the second implementation of the two board contracts. It answers
 * whenever the Postgres path cannot: no connection string at all, or a string
 * that is set but cannot produce a connection (see src/server/store-choice.ts).
 * When a usable Postgres connection IS there, src/server/leaderboard.ts and
 * src/server/player-board.ts answer and this module is never reached.
 *
 * The ranking and the shapes are the SQL's, expressed in JavaScript:
 *
 *   runs     wins desc, overall desc, createdAt asc, id asc   (RANKED_BOARD_SQL)
 *   players  rating desc, seasons desc, bestWins desc,
 *            createdAt asc, deviceToken asc           (RANKED_PLAYERS_SQL)
 *
 * Both orderings already exist as pure functions used by the UI and by the
 * Postgres tests — compareEntries() in src/lib/leaderboard.ts and
 * comparePlayers() in src/lib/player-rating.ts — so the file store cannot
 * invent a third answer to "who is first".
 *
 * The per-identity aggregation repeats the arithmetic of UPSERT_SEASON_SQL
 * exactly: seasons + 1, rating_sum + this season's score, rating =
 * round(rating_sum / seasons, 2), running wins/losses, best_* only when this
 * season is strictly better (more wins, or equal wins with a better roster),
 * perfect_seasons counted, name = the latest display name.
 *
 * Every function here returns a VALUE under all circumstances. A missing or
 * broken document is an empty board; an unwritable directory is the boards'
 * honest "not connected" state. Nothing throws, nothing hangs, nothing 500s.
 *
 * A device's identity on this board is the ONE-WAY KEY of its device token
 * (src/server/player-key.ts), never the token itself — the document is shipped
 * with the site and exported to be carried forward, so it must not carry
 * anything a device treats as its own. Rows written before that change are
 * re-keyed on load, and `playerKeyFor` makes every lookup tolerant of being
 * handed either form.
 */
import {
  MAX_BOARD,
  compareEntries,
  mapBoardRow,
  type BoardData,
  type LeaderboardEntry,
  type Submission,
} from "~/lib/leaderboard";
import {
  MAX_PLAYERS,
  MIN_SEASONS,
  OFFLINE_PLAYERS,
  TIERS,
  comparePlayers,
  mapStandingRow,
  nextTier,
  scoreSeason,
  type PlayerRow,
  type PlayerStanding,
  type PlayersBoardData,
  type SeasonOutcome,
} from "~/lib/player-rating";
import { SEASON_GAMES } from "~/lib/rating";
import type { ProfileSeason } from "~/lib/profile";
import {
  readDocument,
  storeAvailable,
  updateDocument,
  type StoreDoc,
  type StoredPlayer,
  type StoredRun,
} from "~/server/file-store";
import { playerKeyFor } from "~/server/player-key";

/** The same body the Postgres modules return when no store is usable. */
const NOT_CONNECTED_BOARD: BoardData = { connected: false, total: 0, entries: [] };

export type { BoardData };

/** True when a run can be stored at all — an unwritable directory means it cannot. */
export const fileBoardAvailable = storeAvailable;

/* --------------------------------------------------------------- run board */

/**
 * One stored run → the row shape the SQL's SELECT returns, so the mapping and
 * the numbers in the response are produced by exactly the same code as the
 * database path (`mapBoardRow` is shared with it).
 */
const runRow = (run: StoredRun): Record<string, unknown> => ({
  id: run.id,
  name: run.name,
  wins: run.wins,
  losses: run.losses,
  undefeated: run.undefeated,
  overall: run.overall,
  lineup: run.lineup,
  created_at: run.createdAt,
});

/** The whole board, in rank order, capped at MAX_BOARD — as RANKED_BOARD_SQL is. */
const rankRuns = (runs: StoredRun[]): LeaderboardEntry[] =>
  runs
    .map((run) => mapBoardRow(runRow(run)))
    .sort(compareEntries)
    .slice(0, MAX_BOARD);

export async function fileReadBoard(): Promise<BoardData> {
  const doc = await readDocument();
  if (!doc) return NOT_CONNECTED_BOARD;
  return { connected: true, total: doc.runs.length, entries: rankRuns(doc.runs) };
}

/**
 * ONE DEVICE'S SEASONS, from the file-backed board — the profile's read.
 *
 * Attributed by KEY, never by name: a run carries the one-way hash of the device
 * token that posted it, and only an exact match is returned. A run with no key
 * (posted before the key existed) belongs to no profile — see the note on
 * `StoredRun.playerKey`.
 *
 * `key` may be a raw device token or an already-computed key (`playerKeyFor`
 * tolerates both); the caller in src/server/profile.ts passes the hash.
 *
 * `total` is every run the board holds, so a profile can say "3rd of 41" without
 * reading the whole board. `rank` is the run's place on the board, computed with
 * the board's own ordering (`compareEntries`, shared with RANKED_BOARD_SQL) over
 * ALL runs rather than the top MAX_BOARD the board page shows, so a rank is the
 * truth even for a run too low to appear there.
 *
 * Returns null when there is nowhere to read from (the caller then reports the
 * honest "not connected") — never throws, never hangs.
 */
export async function fileReadPlayerSeasons(
  key: string,
): Promise<{ seasons: ProfileSeason[]; total: number } | null> {
  const doc = await readDocument();
  if (!doc) return null;
  const wanted = playerKeyFor(key);
  const ordered = doc.runs.map((run) => mapBoardRow(runRow(run))).sort(compareEntries);
  const rankById = new Map<number, number>();
  ordered.forEach((entry, index) => rankById.set(entry.id, index + 1));
  const seasons: ProfileSeason[] = doc.runs
    .filter((run) => run.playerKey !== null && run.playerKey === wanted)
    .map((run) => ({
      id: run.id,
      wins: run.wins,
      losses: run.losses,
      undefeated: run.undefeated,
      overall: run.overall,
      lineup: run.lineup,
      createdAt: run.createdAt,
      rank: rankById.get(run.id) ?? null,
      total: doc.runs.length,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
  return { seasons, total: doc.runs.length };
}

export interface FileSubmitResult {
  entry: LeaderboardEntry;
  rank: number;
  total: number;
  /** The identity's standing after this season, or null (no token, or none writable). */
  player: PlayerStanding | null;
}

/**
 * Validate-then-store is done by the caller (submitRun owns validation and the
 * rate limit); this only writes. The read, the append and the write all happen
 * inside the store's queue, so two simultaneous submissions cannot lose one.
 *
 * The caller passes the KEYED submission: `submitRun` has hashed the device
 * token already, so `submission.deviceToken` is the one-way key and is what the
 * run's `playerKey` holds — the same value the identity's players-board row is
 * keyed by, which is what lets the device read its own seasons back
 * (`fileReadPlayerSeasons`). A raw token must never reach the document.
 *
 * Returns null only when the document could not be written — the caller turns
 * that into the honest "not connected".
 */
export async function fileSubmitRun(submission: Submission): Promise<FileSubmitResult | null> {
  const createdAt = new Date().toISOString();
  const written = await updateDocument((doc) => {
    const run: StoredRun = {
      id: doc.nextId,
      name: submission.name,
      wins: submission.wins,
      losses: submission.losses,
      undefeated: submission.undefeated,
      overall: submission.overall,
      lineup: submission.lineup,
      playerKey: submission.deviceToken,
      createdAt,
    };
    doc.runs.push(run);
    doc.nextId = run.id + 1;
    // The run and the identity's rating are written by ONE rename, so a run can
    // never be on the board without the rating it earned.
    if (submission.deviceToken) foldSeason(doc, submission.deviceToken, submission.name, submission);
    return doc;
  });
  if (!written) return null;

  const ranks = rankRuns(written.runs);
  const mine = written.runs.reduce((best, run) => (run.id > best.id ? run : best));
  const entry = mapBoardRow(runRow(mine));
  const rank = ranks.findIndex((row) => row.id === mine.id) + 1;
  const token = submission.deviceToken;
  const standing = token === null ? null : standingFor(written, token);
  return { entry, rank: rank > 0 ? rank : 0, total: written.runs.length, player: standing };
}

/* ----------------------------------------------------------- players board */

/**
 * One stored identity → the row shape a gridiron_players SELECT returns, so
 * `mapStandingRow` (shared with the Postgres path) produces the same object, in
 * the same key order, for both stores. The device token is part of the row but
 * is never part of the response — see the mapping functions below.
 */
const playerRow = (player: StoredPlayer): Record<string, unknown> => ({
  device_token: player.deviceToken,
  name: player.name,
  seasons: player.seasons,
  rating: player.rating,
  rating_sum: player.ratingSum,
  wins: player.wins,
  losses: player.losses,
  best_wins: player.bestWins,
  best_losses: player.bestLosses,
  best_overall: player.bestOverall,
  perfect_seasons: player.perfectSeasons,
  created_at: player.createdAt,
  updated_at: player.updatedAt,
});

/** Finish a mapped row into the standing the UI shows (mirrors player-board.ts). */
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

/** Identities that have cleared the seasons gate, in board order. */
const qualifiedPlayers = (doc: StoreDoc): StoredPlayer[] =>
  doc.players
    .filter((player) => player.seasons >= MIN_SEASONS)
    .sort((a, b) =>
      comparePlayers(
        { rating: a.rating, seasons: a.seasons, bestWins: a.bestWins, createdAt: a.createdAt, token: a.deviceToken },
        { rating: b.rating, seasons: b.seasons, bestWins: b.bestWins, createdAt: b.createdAt, token: b.deviceToken },
      ),
    );

/** One identity's standing, with its rank when it has cleared the gate. */
const standingFor = (doc: StoreDoc, token: string): PlayerStanding | null => {
  // The KEY of the device token, never the token itself — player-key.ts.
  const key = playerKeyFor(token);
  const mine = doc.players.find((player) => player.deviceToken === key);
  if (!mine) return null;
  const rank =
    mine.seasons >= MIN_SEASONS
      ? qualifiedPlayers(doc).findIndex((player) => player.deviceToken === key) + 1
      : null;
  return standingFrom(mapStandingRow(playerRow(mine)), rank && rank > 0 ? rank : null);
};

export async function fileReadPlayersBoard(token: string | null = null): Promise<PlayersBoardData> {
  const doc = await readDocument();
  if (!doc) return OFFLINE_PLAYERS;
  // The caller's own row is selected by its KEY; the token is never compared
  // with, or returned from, this document.
  const key = token === null ? null : playerKeyFor(token);
  const qualified = qualifiedPlayers(doc);
  const entries: PlayerRow[] = qualified.slice(0, MAX_PLAYERS).map((player, index) => {
    const mapped = mapStandingRow(playerRow(player));
    return {
      rank: index + 1,
      ...mapped,
      bestOverall: player.bestOverall,
      // Only ever the caller's own row: the key is compared, never returned.
      you: key !== null && player.deviceToken === key,
    };
  });
  return {
    connected: true,
    total: qualified.length,
    identities: doc.players.length,
    minSeasons: MIN_SEASONS,
    tiers: TIERS,
    entries,
    you: token === null ? null : standingFor(doc, token),
  };
}

/* ------------------------------------------------------------- aggregation */

/**
 * Fold ONE completed season into an identity, with the same arithmetic as
 * UPSERT_SEASON_SQL. `outcome` is the submission the run board already
 * validated: the record, the undefeated flag and the lineup's overall rating
 * are all server-derived, and the score is computed here.
 */
const foldSeason = (
  doc: StoreDoc,
  token: string,
  name: string,
  outcome: SeasonOutcome,
): void => {
  const { score } = scoreSeason(outcome);
  const now = new Date().toISOString();
  const losses = SEASON_GAMES - outcome.wins;
  // Keyed by the HASH of the device token, exactly as the table is (see
  // src/server/player-key.ts): a raw token must never reach the document.
  const key = playerKeyFor(token);
  const existing = doc.players.find((player) => player.deviceToken === key);
  if (!existing) {
    doc.players.push({
      deviceToken: key,
      name,
      seasons: 1,
      ratingSum: score,
      rating: score,
      wins: outcome.wins,
      losses,
      bestWins: outcome.wins,
      bestLosses: losses,
      bestOverall: outcome.overall,
      perfectSeasons: outcome.wins >= SEASON_GAMES ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    });
    return;
  }
  const seasons = existing.seasons + 1;
  const ratingSum = round(existing.ratingSum + score);
  const better =
    outcome.wins > existing.bestWins ||
    (outcome.wins === existing.bestWins && outcome.overall > existing.bestOverall);
  existing.name = name;
  existing.seasons = seasons;
  existing.ratingSum = ratingSum;
  // round(sum / seasons, 2) — the SQL's own expression, to the cent.
  existing.rating = round(ratingSum / seasons);
  existing.wins += outcome.wins;
  existing.losses += losses;
  existing.bestWins = better ? outcome.wins : existing.bestWins;
  existing.bestLosses = better ? losses : existing.bestLosses;
  existing.bestOverall = Math.max(existing.bestOverall, outcome.overall);
  existing.perfectSeasons += outcome.wins >= SEASON_GAMES ? 1 : 0;
  existing.updatedAt = now;
};

const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * A season's contribution to one identity's rating, on its own. Used by the
 * players board path when a run arrives with a token; null when nothing could
 * be written (no store, or a write failure), which is not a failure of the run.
 */
export async function fileRecordSeason(
  outcome: SeasonOutcome,
  token: string | null,
  name: string,
): Promise<PlayerStanding | null> {
  if (token === null) return null;
  const written = await updateDocument((doc) => {
    foldSeason(doc, token, name, outcome);
    return doc;
  });
  if (!written) return null;
  return standingFor(written, token);
}

/** Re-exported for the API route's own diagnostics. */
export { storeAvailable as fileStoreAvailable };
