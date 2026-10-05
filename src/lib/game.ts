/**
 * Gridiron Immortals — game logic (no React, no DOM, no network).
 *
 * Everything here is pure so the same rules run on the server and the client:
 *  - the 11-slot starting lineup
 *  - spin groups (one per team + decade present in the player pool)
 *  - eligibility for a spin, so the UI can auto-reroll instead of dead-ending
 *  - era- and position-weighted roster rating
 *  - a fast 17-game season simulation
 *
 * The rating core (roster shape, era/position weights, `rateRoster`) lives in
 * src/lib/rating.ts and is re-exported below: it carries no player data, so
 * server-only code can import it without dragging the pool along. The export
 * surface of this module is unchanged.
 */
import { PLAYERS, type Decade, type Player, type Position } from "~/data/players";
import {
  ROSTER_SLOTS,
  SEASON_GAMES,
  TOTAL_SLOTS,
  rateRoster,
  winProbability,
  type DraftedPlayer,
  type Roster,
  type SlotDef,
  type TeamRatings,
} from "~/lib/rating";

export type { Decade, Player, Position };
export { ROSTER_SLOTS, SEASON_GAMES, TOTAL_SLOTS, rateRoster, winProbability };
export type { DraftedPlayer, Roster, SlotDef, TeamRatings };

/** One spinable team + decade, derived from the player pool. */
export interface Group {
  id: string;
  team: string;
  decade: Decade;
  label: string;
}

const groupId = (team: string, decade: Decade): string => `${team}|${decade}`;

export const GROUPS: Group[] = (() => {
  const seen = new Map<string, Group>();
  for (const p of PLAYERS) {
    const id = groupId(p.team, p.decade);
    if (!seen.has(id)) {
      seen.set(id, { id, team: p.team, decade: p.decade, label: `${p.decade} ${p.team}` });
    }
  }
  return [...seen.values()];
})();

export const groupById = (id: string): Group | undefined => GROUPS.find((g) => g.id === id);

export const playersInGroup = (group: Group): Player[] =>
  PLAYERS.filter((p) => p.team === group.team && p.decade === group.decade);

/** Same person on two era-correct groups counts once per run. */
const nameKey = (name: string): string => name.trim().toLowerCase();

/** How many lineup slots are still open, by position. */
export const openSlots = (roster: Roster): Record<Position, number> => {
  const open = {} as Record<Position, number>;
  for (const slot of ROSTER_SLOTS) open[slot.position] = (open[slot.position] ?? 0) + 1;
  for (const picked of roster) open[picked.position] -= 1;
  return open;
};

export const emptySlots = (roster: Roster): SlotDef[] =>
  ROSTER_SLOTS.filter((def) => !roster.some((d) => d.slot === def.slot));

/** Players from one spin the manager may actually take right now (best first). */
export const eligibleInGroup = (group: Group, roster: Roster): Player[] => {
  const open = openSlots(roster);
  const used = new Set(roster.map((d) => nameKey(d.name)));
  return playersInGroup(group)
    .filter((p) => (open[p.position] ?? 0) > 0 && !used.has(nameKey(p.name)))
    .sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name));
};

/** Guaranteed-non-empty fallback used only if a random draw streak finds nothing. */
export const groupsWithEligible = (roster: Roster): Group[] =>
  GROUPS.filter((g) => eligibleInGroup(g, roster).length > 0);

/**
 * One spin: a uniform random team + decade over the whole pool. A spin with
 * nothing left for the open slots is *not* filtered out here — the caller shows
 * it, then rerolls — so thin spins stay part of the game's rhythm.
 */
export const randomGroup = (rand: () => number = Math.random): Group =>
  GROUPS[Math.floor(rand() * GROUPS.length)] ?? GROUPS[0];

/** Fill the first open slot for that player's position. */
export const draftPlayer = (roster: Roster, player: Player): Roster => {
  const def = emptySlots(roster).find((d) => d.position === player.position);
  if (!def) return roster;
  return [
    ...roster,
    {
      slot: def.slot,
      name: player.name,
      position: player.position,
      team: player.team,
      decade: player.decade,
      rating: player.rating,
    },
  ];
};

/** Deterministic RNG so a run's season can be replayed/re-rendered unchanged. */
export const makeRng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const newSeed = (): number => Math.floor(Math.random() * 4294967296);

const OPPONENTS = [
  "Buffalo Bills",
  "Miami Dolphins",
  "New York Jets",
  "Kansas City Chiefs",
  "Denver Broncos",
  "Los Angeles Chargers",
  "Cincinnati Bengals",
  "Cleveland Browns",
  "Houston Texans",
  "Tennessee Titans",
  "Philadelphia Eagles",
  "Washington Commanders",
  "Atlanta Falcons",
  "Carolina Panthers",
  "New Orleans Saints",
  "Tampa Bay Buccaneers",
  "Detroit Lions",
  "Minnesota Vikings",
  "Chicago Bears",
  "Green Bay Packers",
  "Arizona Cardinals",
  "Los Angeles Rams",
  "Seattle Seahawks",
  "New York Giants",
];

export interface WeekResult {
  week: number;
  opponent: string;
  home: boolean;
  teamScore: number;
  oppScore: number;
  win: boolean;
}

export interface SeasonResult {
  weeks: WeekResult[];
  wins: number;
  losses: number;
  undefeated: boolean;
  ratings: TeamRatings;
  pointsFor: number;
  pointsAgainst: number;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * 17-game season from the roster's era/position-weighted strength.
 * Win probability comes from a logistic curve on overall strength, then a
 * scoreline consistent with the result is generated.
 *
 * The curve itself lives in src/lib/rating.ts as `winProbability` — the players
 * board scores a completed season against the very same curve ("wins above
 * expectation"), so the two must not drift. Calibration (each game independent,
 * so P(17-0) = p^17):
 *   overall 80 → p 0.46 (middling roster, ~8-9)
 *   overall 85 → p 0.68 (good, ~11-6)
 *   overall 88 → p 0.78 (very good, ~13-4, ~1.5% perfect)
 *   overall 91 → p 0.86 (elite, ~15-2, ~7% perfect)
 *   overall 94 → p 0.91 (all-time superteam, ~20% perfect)
 * Drafting the best available player every time lands around 92-94, so a perfect
 * season stays a genuine event rather than the expected outcome.
 */
export const simulateSeason = (roster: Roster, seed: number): SeasonResult => {
  const ratings = rateRoster(roster);
  const rand = makeRng(seed);
  const p = winProbability(ratings.overall);
  const schedule = [...OPPONENTS];
  const weeks: WeekResult[] = [];
  let wins = 0;
  for (let week = 1; week <= SEASON_GAMES; week++) {
    const idx = Math.floor(rand() * schedule.length);
    const opponent = schedule[idx] ?? "AFC Rival";
    // Each opponent is used once; reshuffle names when the list runs short.
    schedule.splice(idx, 1);
    if (schedule.length === 0) schedule.push(...OPPONENTS);
    const home = rand() < 0.5;
    const win = rand() < p;
    let teamScore: number;
    let oppScore: number;
    if (win) {
      wins += 1;
      // A strong offense scores more; the defense keeps the opponent down.
      teamScore = Math.round(clamp(17 + (ratings.offense - 80) * 0.4 + rand() * 13, 10, 45));
      oppScore = Math.round(clamp(teamScore - (1 + rand() * 13), 0, 44));
    } else {
      oppScore = Math.round(clamp(17 + rand() * 14 + (ratings.defense - 80) * 0.2, 6, 48));
      teamScore = Math.round(clamp(oppScore - (1 + rand() * 12), 0, 42));
    }
    weeks.push({ week, opponent, home, teamScore, oppScore, win });
  }
  const pointsFor = weeks.reduce((n, w) => n + w.teamScore, 0);
  const pointsAgainst = weeks.reduce((n, w) => n + w.oppScore, 0);
  return {
    weeks,
    wins,
    losses: SEASON_GAMES - wins,
    undefeated: wins === SEASON_GAMES,
    ratings,
    pointsFor,
    pointsAgainst,
  };
};

export const runSummary = (result: SeasonResult): string =>
  result.undefeated ? "Perfect season" : `${String(result.losses)} loss${result.losses === 1 ? "" : "es"}`;
