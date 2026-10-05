/**
 * Gridiron Immortals — leaderboard contract, validation and ranking rules.
 *
 * Shared by the API route (which is the only place that trusts it) and by the
 * UI (types + display helpers). Nothing here touches the network or the
 * database: `validateSubmission()` is a pure function over untrusted input, so
 * it can be exercised without a database (see tools/leaderboard-check.ts).
 *
 * Trust model: the client sends { name, wins, losses, undefeated, lineup } and
 * the server RE-DERIVES everything it ranks on — record legality, the lineup's
 * legality, and the overall rating. Every pick is matched against the real
 * player pool (src/data/players.ts): the player must exist and the submitted
 * position/team/decade must match that record, and the rating stored is the
 * pool's rating. A client-supplied rating is never stored, so a crafted body of
 * eleven 100s cannot score 100.
 *
 * Pool resilience: the pool is read at validation time and indexed by name, so
 * a larger verified pool dropped into src/data/players.ts needs no changes
 * here — nothing in this file hard-codes a player, a team or a count.
 */
import { PLAYERS, type Player } from "~/data/players";
import { cleanDeviceToken } from "~/lib/player-rating";
import {
  ROSTER_SLOTS,
  SEASON_GAMES,
  overallRating,
  type Decade,
  type DraftedPlayer,
  type Position,
} from "~/lib/rating";

export const NAME_MIN = 3;
export const NAME_MAX = 16;
export const MAX_BOARD = 100;
/** Most picks a submitted lineup may carry (one per open slot). */
export const MAX_LINEUP = ROSTER_SLOTS.length;

/** What the client sends for one drafted player. */
export interface LineupPick {
  /** Lineup slot the player filled ('QB', 'WR1', …) when the client sends it. */
  slot?: string;
  name: string;
  position: Position;
  team: string;
  decade: Decade;
  rating: number;
}

export interface LeaderboardEntry {
  id: number;
  name: string;
  wins: number;
  losses: number;
  undefeated: boolean;
  /** Recomputed server-side from the lineup — never the client's number. */
  overall: number;
  lineup: LineupPick[];
  createdAt: string;
}

export interface BoardData {
  connected: boolean;
  total: number;
  entries: LeaderboardEntry[];
  /**
   * True only when the request never reached the server at all (no network on
   * this device). `connected: false` on its own means the server answered and it
   * has nowhere to store a run — no database connected and no writable
   * file-backed store (see src/server/file-board.ts). Optional: the server never
   * sends it.
   */
  offline?: boolean;
}

export interface Submission {
  name: string;
  wins: number;
  losses: number;
  undefeated: boolean;
  overall: number;
  lineup: LineupPick[];
  /**
   * The device token this run belongs to (see src/lib/player-rating.ts). It is
   * an IDENTITY, not a claim about the result: the players board keys on it, so
   * two devices sharing a name stay two players. Null when the body carried no
   * usable token — the run is still ranked, it just gains no rating.
   */
  deviceToken: string | null;
}

export type ValidationResult =
  | { ok: true; value: Submission }
  | { ok: false; error: string };

const POSITIONS = new Set<string>(ROSTER_SLOTS.map((s) => s.position));
const DECADES = new Set<string>(["1960s", "1970s", "1980s", "1990s", "2000s", "2010s"]);
const SLOTS = new Set<string>(ROSTER_SLOTS.map((s) => s.slot));
const SLOT_POSITION = new Map<string, Position>(ROSTER_SLOTS.map((s) => [s.slot, s.position]));

/**
 * Display names are free text, so clamp hard: strip control characters and
 * angle brackets (cheap injection hygiene), collapse whitespace, cap the
 * length, then require NAME_MIN characters to survive.
 */
export const cleanName = (raw: unknown): string => {
  if (typeof raw !== "string") return "";
  const stripped = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.slice(0, NAME_MAX);
};

const asText = (raw: unknown, max: number): string =>
  typeof raw === "string"
    ? // eslint-disable-next-line no-control-regex
      raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, max)
    : "";

const asInt = (raw: unknown): number | null => {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (!Number.isInteger(raw)) return null;
  return raw;
};

/** Same person on two era-correct records counts once, as in the draft. */
const nameKey = (name: string): string => name.trim().toLowerCase();

/* ------------------------------------------------------------ player pool */

/**
 * The real pool, indexed by lowercase name so a lookup is O(1). Rebuilt when
 * the pool's size changes so a hot-swapped pool (dev HMR, or a new build) is
 * never served stale — and so this file validates against whatever the pool
 * holds at that moment, which is the whole point.
 */
let poolIndex: { size: number; byName: Map<string, Player[]> } | null = null;

const getPool = (): Map<string, Player[]> => {
  if (!poolIndex || poolIndex.size !== PLAYERS.length) {
    const byName = new Map<string, Player[]>();
    for (const player of PLAYERS) {
      const key = nameKey(player.name);
      const list = byName.get(key);
      if (list) list.push(player);
      else byName.set(key, [player]);
    }
    poolIndex = { size: PLAYERS.length, byName };
  }
  return poolIndex.byName;
};

/**
 * The pool record a pick claims to be, or null. The name must be real and the
 * position/team/decade must all match that record — a real player filed under
 * the wrong team or era is not a record the game could have drafted.
 */
const matchPoolPlayer = (pick: { name: string; position: string; team: string; decade: string }): Player | null => {
  const candidates = getPool().get(nameKey(pick.name));
  if (!candidates) return null;
  return (
    candidates.find(
      (p) =>
        p.position === pick.position && p.team === pick.team && p.decade === pick.decade,
    ) ?? null
  );
};

/* ------------------------------------------------------------- normalising */

/** Normalise one pick's *shape*; the pool check happens later. */
const normalizePick = (raw: unknown): LineupPick | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const pick = raw as Record<string, unknown>;
  const name = asText(pick.name, 60).trim();
  const team = asText(pick.team, 60).trim();
  const position = typeof pick.position === "string" ? pick.position : "";
  const decade = typeof pick.decade === "string" ? pick.decade : "";
  const rawSlot = typeof pick.slot === "string" ? pick.slot.trim() : undefined;
  if (name.length === 0 || team.length === 0) return null;
  if (!POSITIONS.has(position)) return null;
  if (!DECADES.has(decade)) return null;
  // A slot, when the client sends one, must be one of the 11 real slots.
  if (rawSlot !== undefined && !SLOTS.has(rawSlot)) return null;
  const normalized: LineupPick = {
    name,
    position: position as Position,
    team,
    decade: decade as Decade,
    // Placeholder: replaced by the pool's own rating below. The body's rating
    // is read nowhere else, so a number in it cannot reach the board.
    rating: 0,
  };
  if (rawSlot !== undefined) normalized.slot = rawSlot;
  return normalized;
};

export const normalizeLineup = (raw: unknown): LineupPick[] | null => {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_LINEUP) return null;
  const picks: LineupPick[] = [];
  for (const item of raw) {
    const pick = normalizePick(item);
    if (!pick) return null;
    picks.push(pick);
  }
  return picks;
};

/**
 * Exactly one pick per roster slot. Two equivalent checks, because either the
 * client tells us the slot ('WR2') or it only tells us the position ('WR'):
 *  - every pick carries a slot → the 11 slots, each filled once, each by a
 *    player of that slot's position;
 *  - no pick carries a slot → the position tally must match the roster's
 *    (QB×1, RB×1, WR×2, …), which is the same statement in aggregate.
 * Both are computed from ROSTER_SLOTS, so a changed roster shape is picked up
 * automatically.
 */
const coversEverySlot = (picks: LineupPick[]): boolean => {
  if (picks.length !== ROSTER_SLOTS.length) return false;
  if (picks.every((p) => p.slot !== undefined)) {
    const filled = new Map<string, LineupPick>();
    for (const pick of picks) {
      const slot = pick.slot as string;
      if (filled.has(slot)) return false;
      if (SLOT_POSITION.get(slot) !== pick.position) return false;
      filled.set(slot, pick);
    }
    return ROSTER_SLOTS.every((def) => filled.has(def.slot));
  }
  const tally = new Map<Position, number>();
  for (const pick of picks) tally.set(pick.position, (tally.get(pick.position) ?? 0) + 1);
  for (const def of ROSTER_SLOTS) {
    const remaining = tally.get(def.position) ?? 0;
    if (remaining <= 0) return false;
    tally.set(def.position, remaining - 1);
  }
  return [...tally.values()].every((left) => left === 0);
};

/**
 * The full server-side gate. Rejects anything that is not a legal completed
 * run: bad name, non-integer or impossible record, a lineup that is not a real
 * 11-slot roster, a player who does not exist in the pool, the same player
 * twice, or a pick whose team/era/position does not match its pool record. The
 * rating is recomputed here from the POOL's ratings.
 */
export const validateSubmission = (input: unknown): ValidationResult => {
  if (typeof input !== "object" || input === null) return { ok: false, error: "invalid_body" };
  const body = input as Record<string, unknown>;

  const name = cleanName(body.name);
  if (name.length < NAME_MIN || name.length > NAME_MAX) return { ok: false, error: "invalid_name" };

  const wins = asInt(body.wins);
  const losses = asInt(body.losses);
  if (wins === null || losses === null) return { ok: false, error: "invalid_record" };
  if (wins < 0 || losses < 0 || wins + losses !== SEASON_GAMES) {
    return { ok: false, error: "invalid_record" };
  }

  const lineup = normalizeLineup(body.lineup);
  if (!lineup) return { ok: false, error: "invalid_lineup" };

  // Pool check, and the only source of a pick's rating.
  const verified: LineupPick[] = [];
  const seen = new Set<string>();
  for (const pick of lineup) {
    const record = matchPoolPlayer(pick);
    if (!record) return { ok: false, error: "invalid_player" };
    const key = nameKey(record.name);
    if (seen.has(key)) return { ok: false, error: "duplicate_player" };
    seen.add(key);
    const stored: LineupPick = {
      name: record.name,
      position: record.position,
      team: record.team,
      decade: record.decade,
      rating: Math.round(record.rating * 10) / 10,
    };
    if (pick.slot !== undefined) stored.slot = pick.slot;
    verified.push(stored);
  }

  // A real completed run fills every roster slot exactly once.
  if (!coversEverySlot(verified)) return { ok: false, error: "invalid_lineup" };

  return {
    ok: true,
    value: {
      name,
      wins,
      losses,
      // Derived, never taken from the client.
      undefeated: wins === SEASON_GAMES,
      overall: overallRating(verified as DraftedPlayer[]),
      lineup: verified,
      // Shape-checked only; the value is generated by the browser, so it can
      // never be verified — see the identity note in src/lib/player-rating.ts.
      deviceToken: cleanDeviceToken(body.deviceToken),
    },
  };
};

/**
 * Board order, mirroring the SQL in src/lib/leaderboard-sql.ts (and the index
 * behind it): every completed season on one board — more wins first, then the
 * better roster rating, then whoever got there first, then id so the order is
 * total. A 17–0 lands on top because 17 wins beats 16; an undefeated season is
 * a badge, not a separate list.
 */
export const compareEntries = (a: LeaderboardEntry, b: LeaderboardEntry): number =>
  b.wins - a.wins ||
  b.overall - a.overall ||
  a.createdAt.localeCompare(b.createdAt) ||
  a.id - b.id;

/** The top few legends to show in a board row. */
export const headlinePicks = (lineup: LineupPick[], count = 3): LineupPick[] =>
  [...lineup].sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name)).slice(0, count);

export const record = (wins: number, losses: number): string => `${wins}–${losses}`;

/* ------------------------------------------------------------- row mapping */

/**
 * Column order for INSERT_RUN_SQL. Shared with the server's write path so the
 * $1..$7 order lives in exactly one place, and so the SQL can be exercised
 * against a real Postgres without a connection string.
 *
 * THE CALLER MUST PASS THE KEYED SUBMISSION: `submitRun` hashes the device token
 * (src/server/player-key.ts) before anything is stored, so the value in
 * `deviceToken` here is already the one-way key and is what the run's
 * `player_key` column gets. Passing a raw token would put a device token in a
 * row, which no store may hold — see the note at the top of player-key.ts.
 */
export const insertParams = (submission: Submission): (string | number | boolean | null)[] => [
  submission.name,
  submission.wins,
  submission.losses,
  submission.undefeated,
  submission.overall,
  JSON.stringify(submission.lineup),
  // Null when the body carried no usable token: the run is still ranked, it just
  // belongs to no profile.
  submission.deviceToken,
];

/** jsonb arrives as a parsed value with most drivers, as text with others. */
const parseLineup = (value: unknown): LineupPick[] => {
  try {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const pick = item as Record<string, unknown>;
      if (typeof pick.name !== "string") return [];
      const entry: LineupPick = {
        name: pick.name,
        position: (typeof pick.position === "string" ? pick.position : "") as Position,
        team: typeof pick.team === "string" ? pick.team : "",
        decade: (typeof pick.decade === "string" ? pick.decade : "") as Decade,
        rating: Number(pick.rating) || 0,
      };
      if (typeof pick.slot === "string") entry.slot = pick.slot;
      return [entry];
    });
  } catch {
    return [];
  }
};

/** One database row → the shape the UI renders. `overall` is numeric, so text. */
export const mapBoardRow = (row: unknown): LeaderboardEntry => {
  const r = (typeof row === "object" && row !== null ? row : {}) as Record<string, unknown>;
  return {
    id: Number(r.id) || 0,
    name: typeof r.name === "string" ? r.name : "—",
    wins: Number(r.wins) || 0,
    losses: Number(r.losses) || 0,
    undefeated: Boolean(r.undefeated),
    overall: Number(r.overall) || 0,
    lineup: parseLineup(r.lineup),
    createdAt: new Date(String(r.created_at)).toISOString(),
  };
};
