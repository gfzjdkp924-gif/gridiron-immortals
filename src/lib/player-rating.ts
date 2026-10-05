/**
 * Gridiron Immortals — the PLAYERS BOARD rating: one persistent rating per
 * game player (an identity), updated by every completed season.
 *
 * Naming: a "player" here is a *game player* — a person who drafted a lineup.
 * An NFL legend in the pool (src/data/players.ts) is always a "pool player".
 *
 * ---------------------------------------------------------------------------
 * WHAT THE RATING IS, IN PLAIN LANGUAGE
 * ---------------------------------------------------------------------------
 * Every completed season is worth a SCORE, and a player's RATING is the plain
 * average of the scores of every season they have finished.
 *
 * A season's score starts at 1000 (the "did what the roster deserved" line) and
 * moves with the result:
 *
 *   1. WINS ABOVE EXPECTATION. The game's own simulation turns a lineup's
 *      overall rating into a per-game win probability (see `winProbability` in
 *      src/lib/rating.ts). A lineup rated 94 is expected to win ~15.5 of 17; a
 *      lineup rated 80 is expected to win ~7.8. The score pays 45 points for
 *      every win above that expectation and takes 45 away for every win below
 *      it. So beating expectation with a WEAK roster pays far more than the same
 *      record with a stacked one, which is the whole point: the pool decides
 *      what the roster was worth, and the player is paid for over-performing it.
 *
 *   2. UNDEFEATED BONUS. 17-0 adds a flat 50.
 *
 *   3. WEAKNESS BONUS. On top of (1), a positive surprise is amplified by up to
 *      20 further points in proportion to how far the lineup sat below the best
 *      lineup the pool could have produced (`POOL_CEIL`, computed from the whole
 *      pool: the top-rated available player at all 11 slots). A stacked roster
 *      gets no amplification; a genuinely weak one gets the full amount. Losses
 *      are never amplified — a bad roster losing is expected, not punished
 *      twice.
 *
 * Because the rating is an AVERAGE, both of the required properties fall out of
 * the arithmetic rather than from a bolted-on rule:
 *   - DIMINISHING RETURNS: the nth season moves the rating by 1/n of its
 *     distance from the running mean, so no amount of grinding can shift a
 *     settled rating far, and each season matters less than the one before.
 *   - GRINDING CANNOT OUT-EARN QUALITY: fifty seasons at 950 average to 950.
 *     Three seasons at 1300 average to 1300. Many mediocre seasons can never
 *     climb past few strong ones, and a losing season genuinely drags a rating
 *     down, permanently.
 *
 * Worked examples, MEASURED from this implementation (the weakness bonus uses
 * the pool's ceiling of 97.4, so weakness = 0.25 at a 94 roster, 1.0 at 80 or
 * below). Every one of these is asserted in tools/players-check.ts:
 *   17-0 with a 94 lineup (expected 15.38): 1000 + 45(1.62) + 50 + 20(1.62)(0.25) = 1131.17
 *   17-0 with an 80 lineup (expected  8.15): 1000 + 45(8.85) + 50 + 20(8.85)(1.00) = 1625.51
 *   15-2 with a 94 lineup (expected 15.38): 1000 + 45(-0.38)            + 0        =  982.94
 *   12-5 with an 80 lineup (expected  8.15): 1000 + 45(3.85)            + 20(3.85) = 1250.51
 *    9-8 with an 80 lineup (expected  8.15): 1000 + 45(0.85)            + 20(0.85) = 1055.51
 *    9-8 with a 94 lineup (expected 15.38): 1000 + 45(-6.38)     + 0    + 0        =  712.94
 *   0-17 with a 94 lineup (expected 15.38): 1000 + 45(-15.38)    + 0    + 0        =  307.94
 *
 * ---------------------------------------------------------------------------
 * TRUST
 * ---------------------------------------------------------------------------
 * Nothing in this file is trusted from the client. The caller (the server) has
 * already re-derived the record, the undefeated flag and the roster's overall
 * rating from the submitted lineup through the pool validation in
 * src/lib/leaderboard.ts. `seasonScore` takes only those server-derived numbers,
 * and the SQL in src/lib/players-sql.ts derives the tally, the best record and
 * the rating itself from the previous row plus one season's contribution — a
 * client-supplied rating, delta or record never reaches a column.
 *
 * ---------------------------------------------------------------------------
 * IDENTITY
 * ---------------------------------------------------------------------------
 * A game player is (display name, device token). The token is a random string
 * the browser creates on first play and keeps in localStorage; it is the primary
 * key, so two devices that pick the same name are two different players, and
 * clearing site data starts a fresh identity. The name is only a label and is
 * freely re-nameable — which is why it is NOT part of the key.
 */
import { PLAYERS } from "~/data/players";
import {
  ERA_STRENGTH,
  ROSTER_SLOTS,
  SEASON_GAMES,
  expectedWins,
  overallRating,
  type Roster,
} from "~/lib/rating";

/* ------------------------------------------------------------------- tiers */

export type Tier = "Rookie" | "Starter" | "Pro Bowl" | "All-Pro" | "Hall of Fame";

/**
 * Tier thresholds on the rating scale. 1000 is "won exactly what the lineup
 * deserved, every time"; the bands are 100 wide so a tier is a real step.
 * Descending, so `tierFor` can find the first band the rating clears.
 *
 * The board prints this table, so thresholds are never a hidden number.
 */
export const TIERS: { tier: Tier; min: number; note: string }[] = [
  { tier: "Hall of Fame", min: 1200, note: "wins well above what the roster deserved" },
  { tier: "All-Pro", min: 1100, note: "beats expectation consistently" },
  { tier: "Pro Bowl", min: 1020, note: "ahead of expectation on balance" },
  { tier: "Starter", min: 950, note: "about what the lineup deserved" },
  { tier: "Rookie", min: 0, note: "under-expecting a drafted roster" },
];

export const tierFor = (rating: number): Tier =>
  (TIERS.find((band) => rating >= band.min) ?? TIERS[TIERS.length - 1]!).tier;

/** A tier's minimum, for the "next tier at N" hint. */
export const nextTier = (rating: number): { tier: Tier; min: number } | null => {
  const above = [...TIERS].filter((band) => band.min > rating).sort((a, b) => a.min - b.min);
  const next = above[0];
  return next ? { tier: next.tier, min: next.min } : null;
};

/* ------------------------------------------------------------ score maths */

/** The line a season scores when it goes exactly as the lineup deserved. */
export const RATING_BASE = 1000;
/** Points per win above (or below) the wins the lineup was expected to take. */
export const WIN_POINT = 45;
/** Flat bonus for 17-0. */
export const UNDEFEATED_BONUS = 50;
/** Most extra points the weakness bonus can add to a positive surprise. */
export const WEAKNESS_BONUS = 20;
/**
 * The rating of a run-of-the-mill draft. Together with POOL_CEIL it turns a
 * lineup's overall rating into "how weak was this roster, as a fraction of the
 * gap between a perfect draft and a mediocre one".
 */
export const MIDDLING_ROSTER = 84;
/** A player must finish this many seasons before appearing on the board. */
export const MIN_SEASONS = 3;
/** Board size cap, same shape as the run board. */
export const MAX_PLAYERS = 100;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const cents = (n: number): number => Math.round(n * 100) / 100;

/**
 * The best lineup the pool can produce: the top-rated available player at every
 * roster slot (~95 today). Read once at load from the whole pool, so adding a
 * legend nudges the weakness scale automatically. Built by the same
 * `overallRating` the game and the server use, so it is comparable by
 * construction.
 */
export const POOL_CEIL: number = (() => {
  const used = new Set<string>();
  const roster: Roster = [];
  for (const def of ROSTER_SLOTS) {
    const best = PLAYERS.filter(
      (p) => p.position === def.position && !used.has(p.name.trim().toLowerCase()),
    ).sort(
      (a, b) =>
        b.rating * ERA_STRENGTH[b.decade] - a.rating * ERA_STRENGTH[a.decade] ||
        a.name.localeCompare(b.name),
    )[0];
    if (!best) continue;
    used.add(best.name.trim().toLowerCase());
    roster.push({
      slot: def.slot,
      name: best.name,
      position: best.position,
      team: best.team,
      decade: best.decade,
      rating: best.rating,
    });
  }
  return overallRating(roster);
})();

/**
 * How weak this lineup was, 0 (as good as the pool allows) → 1 (a middling
 * draft or worse). Pool-relative, so it is the pool — not a hard-coded number —
 * that decides when a roster counts as "weak".
 */
export const rosterWeakness = (overall: number): number =>
  clamp01((POOL_CEIL - overall) / Math.max(1, POOL_CEIL - MIDDLING_ROSTER));

export interface SeasonOutcome {
  /** Server-validated 0..17. */
  wins: number;
  /** Server-recomputed from the lineup; never the client's number. */
  overall: number;
}

export interface SeasonBreakdown {
  /** The season's contribution to the running average. */
  score: number;
  /** Wins the lineup's strength was expected to produce. */
  expectedWins: number;
  /** wins − expectedWins. */
  surprise: number;
  /** 0..1, how far below a perfect draft this lineup sat. */
  weakness: number;
  undefeated: boolean;
}

/**
 * One completed season → the score that gets averaged into the rating.
 * Pure; takes only server-derived numbers. See the header for the worked cases.
 */
export const scoreSeason = ({ wins, overall }: SeasonOutcome): SeasonBreakdown => {
  const expected = expectedWins(overall);
  const surprise = wins - expected;
  const weakness = rosterWeakness(overall);
  const undefeated = wins >= SEASON_GAMES;
  // Only a POSITIVE surprise is amplified by the weakness bonus: a weak roster
  // losing is what it was supposed to do.
  const score =
    RATING_BASE +
    WIN_POINT * surprise +
    (undefeated ? UNDEFEATED_BONUS : 0) +
    WEAKNESS_BONUS * Math.max(0, surprise) * weakness;
  return { score: cents(score), expectedWins: cents(expected), surprise: cents(surprise), weakness, undefeated };
};

/**
 * The running average the database keeps, expressed the same way the SQL does,
 * so the tests can compare the SQL path against the pure path exactly.
 */
export const foldedRating = (previousSum: number, previousSeasons: number, score: number): number =>
  cents((previousSum + score) / (previousSeasons + 1));

/* --------------------------------------------------------------- identity */

/**
 * A device token is 16-64 characters of [a-z0-9] — the browser makes it, the
 * server only checks its shape. It identifies a device, NOT a person: it is the
 * documented weakness of an account-less scheme, and it is deliberately not
 * treated as a secret.
 */
export const TOKEN_PATTERN = /^[a-z0-9]{16,64}$/i;

export const cleanDeviceToken = (raw: unknown): string | null =>
  typeof raw === "string" && TOKEN_PATTERN.test(raw) ? raw.toLowerCase() : null;

/* ------------------------------------------------------- board data shapes */

/** One row on the players board, as the UI renders it. */
export interface PlayerRow {
  /** 1-based position on the board. */
  rank: number;
  name: string;
  rating: number;
  tier: Tier;
  /** Completed seasons folded into the rating. */
  seasons: number;
  wins: number;
  losses: number;
  /** Best single-season record, by wins then roster rating. */
  bestWins: number;
  bestLosses: number;
  bestOverall: number;
  perfectSeasons: number;
  updatedAt: string;
  /** True for the row belonging to the device asking. */
  you: boolean;
}

/** An identity's own standing, shown even before it clears the seasons gate. */
export interface PlayerStanding {
  name: string;
  rating: number;
  tier: Tier;
  seasons: number;
  wins: number;
  losses: number;
  bestWins: number;
  bestLosses: number;
  perfectSeasons: number;
  /** False while `seasons < MIN_SEASONS` — the rating exists, the rank doesn't. */
  qualified: boolean;
  /** Position on the board, or null when below the gate. */
  rank: number | null;
  seasonsToQualify: number;
  nextTier: { tier: Tier; min: number } | null;
  /** When this identity last finished a season. */
  updatedAt: string;
}

export interface PlayersBoardData {
  /** False when DATABASE_URL is missing or the query failed — never an error. */
  connected: boolean;
  /** True only when the request never reached the server (this device is offline). */
  offline?: boolean;
  /** Identities that have cleared MIN_SEASONS. */
  total: number;
  /** Every identity the database knows about, ranked or not. */
  identities: number;
  minSeasons: number;
  /** The published tier table, so the board can print its own thresholds. */
  tiers: { tier: Tier; min: number; note: string }[];
  entries: PlayerRow[];
  you: PlayerStanding | null;
}

export const OFFLINE_PLAYERS: PlayersBoardData = {
  connected: false,
  total: 0,
  identities: 0,
  minSeasons: MIN_SEASONS,
  tiers: TIERS,
  entries: [],
  you: null,
};

export const bestRecord = (row: { bestWins: number; bestLosses: number }): string =>
  `${row.bestWins}–${row.bestLosses}`;

/**
 * Board order, mirroring the ORDER BY in src/lib/players-sql.ts:
 *   rating desc      — the rating is the ranking
 *   seasons desc     — at equal rating, the longer record is the more proven
 *   best_wins desc   — then the better single season
 *   createdAt asc    — then whoever joined first
 *   token asc        — then the token, so the order is total
 */
export const comparePlayers = (
  a: { rating: number; seasons: number; bestWins: number; createdAt: string; token: string },
  b: { rating: number; seasons: number; bestWins: number; createdAt: string; token: string },
): number =>
  b.rating - a.rating ||
  b.seasons - a.seasons ||
  b.bestWins - a.bestWins ||
  a.createdAt.localeCompare(b.createdAt) ||
  a.token.localeCompare(b.token);

/** Database row → the standing shape. Non-primitive columns arrive as text. */
export const mapStandingRow = (
  row: unknown,
): Omit<PlayerStanding, "qualified" | "rank" | "seasonsToQualify" | "nextTier" | "tier"> & {
  tier: Tier;
} => {
  const r = (typeof row === "object" && row !== null ? row : {}) as Record<string, unknown>;
  const rating = Number(r.rating) || 0;
  return {
    name: typeof r.name === "string" ? r.name : "—",
    rating,
    tier: tierFor(rating),
    seasons: Number(r.seasons) || 0,
    wins: Number(r.wins) || 0,
    losses: Number(r.losses) || 0,
    bestWins: Number(r.best_wins ?? r.bestWins) || 0,
    bestLosses: Number(r.best_losses ?? r.bestLosses) || 0,
    perfectSeasons: Number(r.perfect_seasons ?? r.perfectSeasons) || 0,
    updatedAt: new Date(String(r.updated_at ?? r.updatedAt ?? 0)).toISOString(),
  };
};
