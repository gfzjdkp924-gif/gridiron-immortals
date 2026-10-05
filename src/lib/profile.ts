/**
 * Gridiron Immortals — the profile contract, and the rule that decides which
 * season belongs to which player.
 *
 * WHAT A PROFILE IS: every season ONE player has finished, in one list. The
 * player is the same identity the players board uses — a display name plus a
 * device token, keyed by the ONE-WAY hash of the token
 * (`src/server/player-key.ts`). There is no account and no password: the
 * profile is whatever that device and that name have played.
 *
 * TWO SOURCES, MERGED, AND NEVER MIXED UP:
 *
 *  1. THE BOARD (the server's copy). `POST /api/profile` answers with the runs
 *     the board holds FOR THIS DEVICE. They are found by a key, not by a name:
 *     a stored run carries the same one-way hash of the device token that the
 *     players board keys its rows by, so two phones that both call themselves
 *     "John" stay two players and neither profile can pick up the other's
 *     seasons. A run posted before that key existed has no key and is therefore
 *     attributed to nobody — a guess by name is exactly the thing this rule
 *     exists to refuse. Such a season still shows up from the device's own copy
 *     (below), which is where it was played.
 *
 *  2. THE DEVICE (localStorage). `src/lib/storage.ts` keeps the last runs this
 *     device finished, whether or not they were ever posted. A season the device
 *     never posted — or one played before posting existed — still belongs on this
 *     player's history, so it is shown, MARKED as not on the board rather than
 *     counted as if the server had it.
 *
 * DE-DUPLICATION: a posted season exists in both places, so it is shown once.
 * The two copies are matched on the content both sides derive from the same
 * lineup — record, roster rating and the 11 players — because a run's local id
 * is never sent to the server (nothing about a run's identity leaves the device
 * but the token's hash). The board's copy wins when there is one: it carries the
 * rank, and it is the copy that outlives the device.
 */
import type { LineupPick } from "~/lib/leaderboard";
import type { PlayerStanding } from "~/lib/player-rating";
import type { BoardSubmission, StoredRun } from "~/lib/storage";

/** One season as the BOARD holds it, already attributed to this device. */
export interface ProfileSeason {
  id: number;
  wins: number;
  losses: number;
  undefeated: boolean;
  overall: number;
  lineup: LineupPick[];
  /** ISO-8601, when the board recorded it. */
  createdAt: string;
  /** Position on the runs board, or null when it could not be placed. */
  rank: number | null;
  /** Runs on the board at the time of the read. */
  total: number;
}

/** What `POST /api/profile` returns. Never throws, never a 500. */
export interface ProfileData {
  /** The board's storage answered. False = it has nowhere to read from. */
  connected: boolean;
  /** True only when the request never reached the server at all. */
  offline?: boolean;
  /** This device's standing on the players board, or null. */
  player: PlayerStanding | null;
  /** Seasons on the board posted by this device, newest first. */
  seasons: ProfileSeason[];
  /** Every run the board holds, for the "N of M" line. */
  boardTotal: number;
  /** How a season is attributed, printed on the page so the rule is never hidden. */
  attribution: string;
}

export const OFFLINE_PROFILE: ProfileData = {
  connected: false,
  offline: true,
  player: null,
  seasons: [],
  boardTotal: 0,
  attribution: "",
};

/**
 * How a season is attributed to a player, in one paragraph. It lives here (not
 * in the server-only module) so the page can print it even when it never got a
 * response, and `src/server/profile.ts` sends exactly this string — one
 * sentence, one place.
 */
export const PROFILE_ATTRIBUTION_FALLBACK =
  "Seasons are matched to the device that posted them by a one-way key made from this browser's own token — never by the display name, so two players who choose the same name stay two players. A season posted before that key existed, or never posted at all, appears from this device's own copy instead.";

/** The server answered, but had nowhere to read a board from. */
export const NO_STORE_PROFILE: ProfileData = {
  connected: false,
  offline: false,
  player: null,
  seasons: [],
  boardTotal: 0,
  attribution: "",
};

/** Where one line of a profile came from — printed on every season row. */
export type SeasonSource = "board" | "device-posted" | "device-only";

/** One season on the page, after the two sources have been merged. */
export interface ProfileSeasonRow {
  /** Stable React key / test hook. */
  key: string;
  source: SeasonSource;
  /** True when the BOARD holds this season for this device. */
  onBoard: boolean;
  /** The board's row id, or null for a device-only season. */
  boardId: number | null;
  wins: number;
  losses: number;
  undefeated: boolean;
  overall: number;
  lineup: LineupPick[];
  /** ms since epoch, for ordering. */
  finishedAt: number;
  /** ISO-8601, for display. */
  playedAt: string;
  /** Rank on the runs board, when the board holds it. */
  rank: number | null;
  total: number;
}

/* ------------------------------------------------------------- signatures */

const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * What two copies of the same season agree on: the record, the roster rating
 * and the 11 players. Names are sorted so a differing lineup order cannot split
 * one season into two.
 */
const signature = (season: {
  wins: number;
  losses: number;
  overall: number;
  lineup: LineupPick[];
}): string => {
  const players = season.lineup
    .map((pick) => `${pick.slot ?? pick.position}:${pick.name}:${pick.decade}:${pick.team}`)
    .sort()
    .join("|");
  return `${String(season.wins)}-${String(season.losses)}-${round1(season.overall).toFixed(1)}-${players}`;
};

const timeOf = (iso: string): number => {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/* ------------------------------------------------------------------ merge */

/**
 * The merged, de-duplicated history, newest first.
 *
 * `board` is what the server says it holds for this device; `runs` and
 * `submissions` are this device's own records (`src/lib/storage.ts`). A board
 * season claims at most one matching local run, so two identical seasons stay
 * two seasons where both copies exist twice.
 */
export const mergeProfileSeasons = (
  board: ProfileSeason[],
  runs: StoredRun[],
  submissions: Record<string, BoardSubmission>,
): ProfileSeasonRow[] => {
  // Local runs by signature, newest first, so a board season claims the run it
  // was played from and not an older twin.
  const bySignature = new Map<string, StoredRun[]>();
  for (const run of [...runs].sort((a, b) => b.finishedAt - a.finishedAt)) {
    const key = signature({ wins: run.wins, losses: run.losses, overall: run.overall, lineup: run.roster });
    const list = bySignature.get(key);
    if (list) list.push(run);
    else bySignature.set(key, [run]);
  }

  const claimed = new Set<string>();
  const rows: ProfileSeasonRow[] = [];

  for (const season of board) {
    const key = signature(season);
    const match = (bySignature.get(key) ?? []).find((run) => !claimed.has(run.id)) ?? null;
    if (match) claimed.add(match.id);
    rows.push({
      key: `board-${String(season.id)}`,
      source: "board",
      onBoard: true,
      boardId: season.id,
      wins: season.wins,
      losses: season.losses,
      undefeated: season.undefeated || season.wins >= 17,
      overall: round1(season.overall),
      lineup: season.lineup,
      finishedAt: timeOf(season.createdAt) || match?.finishedAt || 0,
      playedAt: season.createdAt,
      rank: season.rank,
      total: season.total,
    });
  }

  for (const run of runs) {
    if (claimed.has(run.id)) continue;
    const posted = submissions[run.id] !== undefined;
    rows.push({
      key: `device-${run.id}`,
      source: posted ? "device-posted" : "device-only",
      onBoard: false,
      boardId: null,
      wins: run.wins,
      losses: run.losses,
      undefeated: run.undefeated || run.wins >= 17,
      overall: round1(run.overall),
      lineup: run.roster,
      finishedAt: run.finishedAt,
      playedAt: new Date(run.finishedAt).toISOString(),
      rank: null,
      total: 0,
    });
  }

  return rows.sort((a, b) => b.finishedAt - a.finishedAt);
};

/** Best run: most wins, then the better roster — the game's own rule. */
export const bestProfileSeason = (rows: ProfileSeasonRow[]): ProfileSeasonRow | null =>
  rows.length === 0
    ? null
    : rows.reduce((best, row) =>
        row.wins > best.wins || (row.wins === best.wins && row.overall > best.overall) ? row : best,
      );

export const profileRecord = (wins: number, losses: number): string => `${String(wins)}–${String(losses)}`;
