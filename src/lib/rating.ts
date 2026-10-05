/**
 * Gridiron Immortals — pure, data-free game core.
 *
 * This module holds the parts of the game that carry NO player data: the roster
 * shape, the era/position weighting and `rateRoster()`. It exists so that
 * server-only code (the leaderboard API, which must recompute a submitted run's
 * rating rather than trust the client) can import the exact same rating maths
 * without pulling the whole player pool into the server bundle.
 *
 * `src/lib/game.ts` re-exports everything here, so game behaviour and the public
 * import surface are unchanged. Treat the numbers below as calibrated: the
 * season simulation's undefeated rate depends on them (see game.ts).
 */
import type { Decade, Position } from "~/data/players";

export type { Decade, Position };

/** One lineup slot. WR appears twice. */
export interface SlotDef {
  slot: string;
  position: Position;
  label: string;
}

export const ROSTER_SLOTS: SlotDef[] = [
  { slot: "QB", position: "QB", label: "Quarterback" },
  { slot: "RB", position: "RB", label: "Running Back" },
  { slot: "WR1", position: "WR", label: "Wide Receiver" },
  { slot: "WR2", position: "WR", label: "Wide Receiver" },
  { slot: "TE", position: "TE", label: "Tight End" },
  { slot: "OL", position: "OL", label: "Offensive Line" },
  { slot: "DL", position: "DL", label: "Defensive Line" },
  { slot: "LB", position: "LB", label: "Linebacker" },
  { slot: "CB", position: "CB", label: "Cornerback" },
  { slot: "S", position: "S", label: "Safety" },
  { slot: "K", position: "K", label: "Kicker" },
];

export const TOTAL_SLOTS = ROSTER_SLOTS.length;

/** A season is always 17 games — the leaderboard validates records against this. */
export const SEASON_GAMES = 17;

/** A drafted player, tied to the lineup slot he filled. */
export interface DraftedPlayer {
  slot: string;
  name: string;
  position: Position;
  team: string;
  decade: Decade;
  rating: number;
}

export type Roster = DraftedPlayer[];

/**
 * Era weighting. Older pools are shallower, so a great 1960s squad is nudged up
 * and a great 2010s squad nudged down — this is what keeps a "1990s Cowboys"
 * run and a "1960s Packers" run comparable.
 */
export const ERA_STRENGTH: Record<Decade, number> = {
  "1960s": 1.03,
  "1970s": 1.02,
  "1980s": 1.01,
  "1990s": 1.0,
  "2000s": 0.99,
  "2010s": 0.98,
};

/** Position weighting: QB and the lines decide games; kickers barely move it. */
export const POSITION_WEIGHT: Record<Position, number> = {
  QB: 2.4,
  RB: 1.7,
  WR: 1.4,
  TE: 1.0,
  OL: 2.0,
  DL: 2.2,
  LB: 1.9,
  CB: 1.6,
  S: 1.3,
  K: 0.7,
};

export interface TeamRatings {
  offense: number;
  defense: number;
  special: number;
  overall: number;
}

const unit = (roster: Roster, positions: Position[]): number => {
  const parts = roster.filter((d) => positions.includes(d.position));
  if (parts.length === 0) return 0;
  let sum = 0;
  let weight = 0;
  for (const p of parts) {
    const w = POSITION_WEIGHT[p.position];
    sum += p.rating * ERA_STRENGTH[p.decade] * w;
    weight += w;
  }
  return weight === 0 ? 0 : sum / weight;
};

export const rateRoster = (roster: Roster): TeamRatings => {
  const offense = unit(roster, ["QB", "RB", "WR", "TE", "OL"]);
  const defense = unit(roster, ["DL", "LB", "CB", "S"]);
  const special = unit(roster, ["K"]);
  const weighted = unit(roster, ROSTER_SLOTS.map((s) => s.position));
  const overall =
    offense === 0 || defense === 0 ? weighted : offense * 0.45 + defense * 0.47 + special * 0.08;
  return { offense, defense, special, overall };
};

/** Overall rating as the game stores and shows it (one decimal place). */
export const overallRating = (roster: Roster): number =>
  Math.round(rateRoster(roster).overall * 10) / 10;

/**
 * The season simulation's single calibration curve: a roster's overall rating →
 * the probability that roster wins any one game.
 *
 * It lives here (in the data-free core) rather than inside `simulateSeason` for
 * one reason: the POST-SEASON SCORE of a completed run — the number the players
 * board ranks — is defined as "wins above what this lineup should have won", and
 * "should have won" is exactly `SEASON_GAMES * winProbability(overall)`. Sharing
 * the one curve means the players board can never disagree with the game about
 * how good a roster is. Changing these three numbers changes both at once, on
 * purpose.
 *
 *   overall 80 → p 0.46 (middling roster, ~8-9 wins expected)
 *   overall 85 → p 0.68 (good, ~11-6)
 *   overall 88 → p 0.78 (very good, ~13-4)
 *   overall 91 → p 0.86 (elite, ~15-2)
 *   overall 94 → p 0.91 (all-time superteam, ~15.5-1.5)
 */
export const WIN_PROB_SHIFT = 80.5;
export const WIN_PROB_SLOPE = 6;
export const WIN_PROB_MIN = 0.25;
export const WIN_PROB_MAX = 0.93;

export const winProbability = (overall: number): number =>
  Math.min(
    WIN_PROB_MAX,
    Math.max(WIN_PROB_MIN, 1 / (1 + Math.exp(-(overall - WIN_PROB_SHIFT) / WIN_PROB_SLOPE))),
  );

/** Wins a lineup of this strength is *expected* to take from a 17-game season. */
export const expectedWins = (overall: number): number => SEASON_GAMES * winProbability(overall);
