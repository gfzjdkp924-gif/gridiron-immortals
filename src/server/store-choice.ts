/**
 * Gridiron Immortals — which store answers the boards (SERVER ONLY).
 *
 * ONE RULE, FOR BOTH BOARDS: Postgres answers when a connection string is set
 * AND that connection is actually usable. When a string is set but cannot be
 * used — a truncated secret, a wrong password, a paused project, a refused host
 * — the file-backed store (src/server/file-board.ts) answers instead.
 *
 * WHY THE SECOND HALF OF THAT RULE EXISTS: on 2026-10-04 the live runtime
 * carried `NEON_DATABASE_URL` with the 14-character value `postgresql://`. The
 * old rule ("a string is set, therefore Postgres wins") sent every board request
 * down the Postgres path, where it threw instantly, and both boards went dark —
 * `GET /api/leaderboard` answered `connected:false` and a finished season could
 * not be stored anywhere, even though the file store was working and writable.
 * A broken connection string must never take the boards down: the game is played
 * by people, and their runs have to land somewhere.
 *
 * WHAT THIS DOES NOT CHANGE: when Postgres answers, it wins outright and the
 * file's rows are never mixed in — one board, one source. The file store is only
 * reached when there is no string at all, or when the string that is there
 * cannot produce a connection.
 *
 * COST: a failed attempt is remembered for `POSTGRES_RETRY_MS`, so a database
 * that is down does not cost every visitor the driver's connect timeout (10s for
 * the TCP client) — during the cooldown the file store answers immediately. The
 * memo is a cooldown, not a verdict: after it expires the connection is tried
 * again, and a database that comes back starts working with no redeploy.
 */
import { dbConfigured } from "~/db";

/** How long a connection failure is trusted before Postgres is tried again. */
export const POSTGRES_RETRY_MS = 60_000;

/** When the next Postgres attempt is allowed; 0 means "now". */
let nextAttemptAt = 0;

/** The message of an unknown error, for the server log. */
export const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Remember that the configured connection could not be used. Called for a
 * failure at any point on the Postgres path (connect, schema, or a query), so
 * the boards all agree on which store is answering.
 */
export const notePostgresFailure = (): void => {
  nextAttemptAt = Date.now() + POSTGRES_RETRY_MS;
};

/**
 * Can the configured Postgres be used at all? `probe` is the board's own
 * idempotent schema step — the cheapest statement that proves a real connection,
 * and already memoised on success by each board module.
 *
 * Returns false when there is no connection string (the ordinary file-store
 * case), when the string cannot produce a connection, and while a recent failure
 * is still in its cooldown.
 */
export const postgresAnswers = async (probe: () => Promise<void>): Promise<boolean> => {
  if (!dbConfigured()) return false;
  if (Date.now() < nextAttemptAt) return false;
  try {
    await probe();
    return true;
  } catch (error: unknown) {
    notePostgresFailure();
    console.error(
      `[db] the configured connection string cannot be used — the file-backed boards answer instead: ${describeError(error)}`,
    );
    return false;
  }
};
