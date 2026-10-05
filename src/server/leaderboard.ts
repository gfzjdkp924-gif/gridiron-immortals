/**
 * Gridiron Immortals — leaderboard server logic (SERVER ONLY).
 *
 * Import this from a `createServerFn` handler or an `src/routes/api/*` route,
 * never from a component. Every exported function swallows database failures
 * and reports them as data (`connected: false` / `error: "not_connected"`) so
 * that a missing or unreachable database can never break the game loop or leak
 * a raw driver error into the UI.
 *
 * TWO STORES, ONE CONTRACT: a Postgres connection string wins whenever one is
 * set. With none set, the boards are served by the file-backed store
 * (src/server/file-board.ts) instead of reporting "not connected" — the same
 * response shapes, the same ranking, the same refusal to throw. "Not connected"
 * now means only what it says: nowhere to store the run.
 */
import { createHash } from "node:crypto";

import { dbConfigured, sql } from "~/db";
import {
  MAX_BOARD,
  insertParams,
  mapBoardRow,
  validateSubmission,
  type BoardData,
  type LeaderboardEntry,
} from "~/lib/leaderboard";
import {
  COUNT_RUNS_SQL,
  INSERT_RUN_SQL,
  RANKED_BOARD_SQL,
  RANK_OF_RUN_SQL,
  SCHEMA_STATEMENTS,
} from "~/lib/leaderboard-sql";
import { fileBoardAvailable, fileReadBoard, fileSubmitRun } from "~/server/file-board";
import { notePostgresFailure, postgresAnswers } from "~/server/store-choice";
import { playerKeyOrNull } from "~/server/player-key";
import { recordSeason, type PlayerStanding } from "~/server/player-board";

export type { BoardData };

/* ------------------------------------------------------------------ schema */

/** Re-exported so existing callers of this module keep working. */
export { dbConfigured };

let schemaReady: Promise<void> | null = null;

/**
 * Create the table/index on first use, idempotently, and remember success for
 * the life of the process. A failure clears the memo so the next request tries
 * again (a database that comes up later starts working without a redeploy).
 */
const ensureSchema = async (): Promise<void> => {
  if (!schemaReady) {
    schemaReady = (async () => {
      const db = sql();
      for (const statement of SCHEMA_STATEMENTS) await db.query(statement, []);
    })().catch((error: unknown) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
};

/* ------------------------------------------------------------------- rows */

const message = (error: unknown): string =>
  error instanceof Error ? error.message : "unknown database error";

/**
 * Rows from one parameterised query. The neon helper's generics describe its
 * array/full-results modes rather than the row type, so the rows are asserted
 * here once, behind a runtime guard, instead of at every call site.
 */
const rows = async <T>(text: string, params: unknown[]): Promise<T[]> => {
  const result: unknown = await sql().query(text, params);
  return (Array.isArray(result) ? result : []) as T[];
};

/* ------------------------------------------------------------------- read */

/**
 * Are the boards answering from the database right now? The same one-line rule
 * the readers use, exported so a caller cannot invent a different answer — the
 * board export at /api/board-export is the only user: when the database is the
 * live board, the shipped file document is NOT, and must not be carried forward.
 */
export const boardsUseDatabase = (): Promise<boolean> => postgresAnswers(ensureSchema);
export async function readBoard(): Promise<BoardData> {
  // No USABLE connection string → the file-backed board
  // (src/server/file-board.ts), which answers with the same shape and reports
  // its own "not connected" when it has nowhere writable to put the document.
  // A string that is set but cannot connect counts as no usable string: a broken
  // secret must not be able to take the board down (see store-choice.ts).
  if (!(await postgresAnswers(ensureSchema))) return fileReadBoard();
  try {
    await ensureSchema();
    const board = await rows<Record<string, unknown>>(RANKED_BOARD_SQL, [MAX_BOARD]);
    const totals = await rows<{ total: number }>(COUNT_RUNS_SQL, []);
    return {
      connected: true,
      total: Number(totals[0]?.total ?? 0),
      entries: board.map(mapBoardRow),
    };
  } catch (error: unknown) {
    console.error("[leaderboard] read failed:", message(error));
    // The database went away mid-request: the file store answers from here, and
    // the next request re-probes rather than paying this failure again.
    notePostgresFailure();
    return fileReadBoard();
  }
}

/* ---------------------------------------------------------------- limiting */

const RATE_LIMIT = 8;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_KEYS = 2000;
const attempts = new Map<string, number[]>();

/** Cheap per-process sliding window. Enough for a friendly game board. */
export const withinRateLimit = (key: string): boolean => {
  const now = Date.now();
  const recent = (attempts.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    attempts.set(key, recent);
    return false;
  }
  recent.push(now);
  attempts.set(key, recent);
  if (attempts.size > RATE_MAX_KEYS) {
    for (const [k, v] of attempts) {
      if (v.every((t) => now - t >= RATE_WINDOW_MS)) attempts.delete(k);
    }
  }
  return true;
};

/**
 * Hash the caller's IP rather than storing it: we only need to count repeats,
 * never to identify anyone.
 */
export const callerKey = (request: Request): string => {
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  const ip =
    forwarded.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("cf-connecting-ip")?.trim() ||
    "unknown";
  return createHash("sha256").update(`gridiron|${ip}`).digest("hex").slice(0, 24);
};

/* ------------------------------------------------------------------ write */

export type SubmitOutcome =
  | {
      ok: true;
      entry: LeaderboardEntry;
      rank: number;
      total: number;
      /**
       * The submitting identity's standing on the PLAYERS board after this
       * season, or null if the rating could not be written (no token, no
       * database, or a write error). Never a failure of the run itself.
       */
      player: PlayerStanding | null;
    }
  | { ok: false; error: "not_connected" | "rate_limited" | string };

/**
 * Validate, then store. The rating is recomputed from the lineup by
 * `validateSubmission` — the client's number is never written. Returns a
 * post-insert rank computed with the board's own ordering.
 *
 * Every completed season then folds into the submitting device's players-board
 * rating. That step is deliberately last and deliberately non-fatal: the run is
 * already stored, so a rating problem downgrades to `player: null` instead of
 * costing the player their run.
 */
export async function submitRun(payload: unknown, caller: string): Promise<SubmitOutcome> {
  const checked = validateSubmission(payload);
  if (!checked.ok) return { ok: false, error: checked.error };
  const submission = checked.value;
  // The players board — in Postgres and in the file document alike — is keyed by
  // a ONE-WAY HASH of the device token, never by the token itself
  // (src/server/player-key.ts). Hashing happens here, once, at the boundary every
  // submission passes through, so both stores are handed the same key and no
  // store can be handed a raw token by accident. The run row itself never
  // carried a token at all.
  const keyed = { ...submission, deviceToken: playerKeyOrNull(submission.deviceToken) };

  // Which store answers: a USABLE Postgres connection always wins, and only when
  // there is none (or the one configured cannot connect) does the file-backed
  // store take the run. When neither can store it (no usable connection AND no
  // writable directory), this is the same honest "not connected" the boards
  // reported before the file store existed.
  const useDatabase = await postgresAnswers(ensureSchema);
  if (!useDatabase && !(await fileBoardAvailable())) return { ok: false, error: "not_connected" };
  // Charged only on an otherwise-acceptable submission, and before either store
  // is touched at all. The limit itself is unchanged: 8 runs per caller per
  // 10-minute window, keyed by the hashed IP, counted in this process's memory.
  if (!withinRateLimit(caller)) return { ok: false, error: "rate_limited" };

  if (!useDatabase) {
    const stored = await fileSubmitRun(keyed);
    // The document could not be written (a directory that went read-only, a
    // full disk): the same honest failure the boards have always reported.
    return stored ? { ok: true, ...stored } : { ok: false, error: "not_connected" };
  }

  /** Set the moment the run reaches Postgres, so a later failure cannot re-write it. */
  let storedId: number | null = null;
  try {
    await ensureSchema();
    const inserted = await rows<{ id: number; created_at: unknown }>(
      // `keyed`, not `submission`: $7 is the run's player_key, which must be the
      // one-way hash and never the token the browser sent (see insertParams).
      INSERT_RUN_SQL,
      insertParams(keyed),
    );
    const row = inserted[0];
    if (!row) throw new Error("insert returned no row");
    storedId = row.id;

    const rankRows = await rows<{ rank: number }>(RANK_OF_RUN_SQL, [row.id]);
    const totals = await rows<{ total: number }>(COUNT_RUNS_SQL, []);
    const player = await recordSeason(
      { wins: submission.wins, overall: submission.overall },
      keyed.deviceToken,
      submission.name,
    );
    return {
      ok: true,
      entry: {
        id: Number(row.id),
        name: submission.name,
        wins: submission.wins,
        losses: submission.losses,
        undefeated: submission.undefeated,
        overall: submission.overall,
        lineup: submission.lineup,
        createdAt: new Date(String(row.created_at)).toISOString(),
      },
      rank: Number(rankRows[0]?.rank ?? 0),
      total: Number(totals[0]?.total ?? 0),
      player,
    };
  } catch (error: unknown) {
    console.error("[leaderboard] insert failed:", message(error));
    // The connection failed mid-request. If the run had already reached
    // Postgres it must NOT be written a second time into the file board — it is
    // stored, and an unknown rank (0) is honest where a guessed one is not.
    if (storedId !== null) {
      return {
        ok: true,
        entry: {
          id: storedId,
          name: submission.name,
          wins: submission.wins,
          losses: submission.losses,
          undefeated: submission.undefeated,
          overall: submission.overall,
          lineup: submission.lineup,
          createdAt: new Date().toISOString(),
        },
        rank: 0,
        total: 0,
        player: null,
      };
    }
    notePostgresFailure();
    const stored = await fileSubmitRun(keyed);
    return stored ? { ok: true, ...stored } : { ok: false, error: "not_connected" };
  }
}
