/**
 * Rendering helpers for the `stats` field on a player record.
 * ---------------------------------------------------------------------------
 * The pool (src/data/players.ts) carries 2-3 short key/value pairs describing a
 * player's average season for his tagged franchise inside his tagged decade, and
 * documents the key legend. This module is the ONLY place that turns those keys
 * into something a card can show, so every surface (draft pool, lineup, result
 * screen) renders the same shape.
 *
 * Rules, straight from the pool's header:
 *   · keys are short on purpose: pass/td/int · rush/td/ypc · rec/recy/td ·
 *     sck/fr/gp/gs · fg/fgp — labels below are those keys, uppercased.
 *   · "n/a" is an honest gap in the record, never a number. It is DROPPED here,
 *     so the literal string can never reach the screen. A record with nothing
 *     displayable renders nothing at all (not a broken label).
 *   · counting yards get thousands separators (PASS 4,102); per-carry keeps its
 *     one decimal (YPC 4.5); "fg" stays "made-attempted" (FG 16-28) and "fgp" is
 *     a percentage, so it is shown with a % sign.
 *   · at most three pairs are shown.
 *
 * Order: the pairs render in the order the record lists its keys, which is the
 * per-position convention the pool header documents (QB pass/td/int,
 * RB rush/td/ypc, WR & TE rec/recy/td, ...).
 */
import { PLAYERS } from "~/data/players";
import type { PlayerStats } from "~/data/players";

/** Compact on-card labels, one per documented key. */
export const STAT_LABELS: Record<string, string> = {
  pass: "PASS",
  td: "TD",
  int: "INT",
  rush: "RUSH",
  ypc: "YPC",
  rec: "REC",
  recy: "RECY",
  sck: "SCK",
  fr: "FR",
  gp: "GP",
  gs: "GS",
  fg: "FG",
  fgp: "FGP",
};

/** Yards and anything else in the thousands get separators; per-carry does not. */
const DECIMAL_KEYS = new Set(["ypc"]);

/** The value the pool uses for "the NFL did not record this in that era". */
const MISSING = "n/a";

export interface StatPair {
  /** Pool key, e.g. "pass". Also used as a stable React key / data attribute. */
  key: string;
  /** Compact label, e.g. "PASS". */
  label: string;
  /** Display-ready value, e.g. "4,102", "4.5", "16-28", "57%". */
  value: string;
}

const isMissing = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  (typeof value === "string" && value.trim().toLowerCase() === MISSING);

const formatValue = (key: string, value: number | string): string => {
  if (typeof value === "number") {
    if (DECIMAL_KEYS.has(key) || !Number.isInteger(value)) return String(value);
    const text = Math.abs(value) >= 1000 ? value.toLocaleString("en-US") : String(value);
    return key === "fgp" ? `${text}%` : text;
  }
  // Strings are already display-ready ("16-28"), except a bare percentage.
  const text = value.trim();
  return key === "fgp" ? `${text}%` : text;
};

/** Display-ready pairs for a record, in record order, "n/a" dropped, max three. */
export const statPairs = (stats?: PlayerStats | null): StatPair[] => {
  if (!stats) return [];
  const pairs: StatPair[] = [];
  for (const key of Object.keys(stats)) {
    const value = stats[key];
    if (isMissing(value)) continue;
    pairs.push({
      key,
      label: STAT_LABELS[key] ?? key.toUpperCase(),
      value: formatValue(key, value as number | string),
    });
    if (pairs.length === 3) break;
  }
  return pairs;
};

/**
 * The full stat line, e.g. "PASS 4,102 · TD 32 · INT 11". Empty string when the
 * record has nothing displayable — callers must render nothing in that case.
 */
export const statLine = (stats?: PlayerStats | null): string =>
  statPairs(stats)
    .map((pair) => `${pair.label} ${pair.value}`)
    .join(" · ");

/**
 * Pool stats for a drafted player. Drafted rosters (and runs restored from
 * localStorage) store name/team/decade rather than the whole record, so the
 * lineup and result screen look the line up here. Returns undefined for a
 * player no longer in the pool — the card then shows no stat line.
 */
const statsIndex = new Map<string, PlayerStats>();
for (const player of PLAYERS) {
  statsIndex.set(`${player.name}|${player.team}|${player.decade}`, player.stats);
}

export const statsFor = (pick: {
  name: string;
  team: string;
  decade: string;
}): PlayerStats | undefined => statsIndex.get(`${pick.name}|${pick.team}|${pick.decade}`);
