/**
 * Gridiron Immortals — the anonymous finished-season counter (the numbers only).
 *
 * WHY IT EXISTS. A finished season used to leave no trace we could see: posting
 * to the board needs the $4.99 unlock and a profile is device-local, so "did
 * anyone actually play the free run?" was unanswerable unless someone paid. The
 * owner hands the game to people they know, and the only honest measure they get
 * back is a count of finished seasons. This is that count.
 *
 * WHAT IT IS, EXACTLY. Two running totals and two per-day tallies:
 *
 *   runsFinished   every finished season ever counted
 *   firstRuns      of those, the ones that were the FIRST season that device
 *                  had ever finished — the closest thing to "someone new played"
 *                  that can be counted without identifying anyone
 *   byDay          the same count, per UTC day, last 30 days kept
 *   firstByDay     the first-run count, per UTC day, last 30 days kept
 *   updatedAt      when the counters last moved (server clock)
 *
 * WHAT IT IS NOT: it counts RUNS, never PEOPLE. No counter request carries a
 * device token, a cookie, a name, an IP address, a user agent or any other
 * identifier — `POST /api/run-count` takes one bare boolean and stores nothing
 * but these increments. Two players who both finished three seasons are six in
 * `runsFinished` and we cannot tell them apart, on purpose. That is what makes
 * it publishable immediately next to /privacy.
 *
 * THE SHAPE IS FLAT ON PURPOSE. These live INSIDE the board document
 * (`<deploy root>/.data/board.json`, src/server/file-store.ts) rather than in a
 * file of their own: the board document is the one thing a publish carries
 * forward (tools/board-sync.sh), so a separate file's counters would be wiped by
 * the next redeploy.
 *
 * THIS MODULE IS PURE — numbers in, numbers out, no filesystem, no fetch — so
 * the store, the sync-facing server code and the tests all share one definition
 * of "add one season" and one definition of "merge two counter sets".
 *
 * THE MERGE IS THE SAFETY RULE. Counters only ever grow, so the largest value
 * ever seen for a total, or for a day, is the truth we keep. A degraded, empty
 * or unreadable read therefore cannot ZERO them: it can only be ignored. Both
 * the server store (the process-lifetime high-water in src/server/file-store.ts)
 * and the carry-forward step (tools/board-sync.sh, whose Python mirrors
 * `mergeRunStats` below) apply the same rule. Keeping the two in step is a
 * deliberate duplication; the tests in tools/run-count-check.ts cover both.
 */

/** The counters, exactly as the board document stores them. */
export interface RunStats {
  /** Every finished season ever counted. */
  runsFinished: number;
  /** Of those, the seasons that were a device's first finished season. */
  firstRuns: number;
  /** UTC day (`YYYY-MM-DD`) → finished seasons counted that day, last 30 days. */
  byDay: Record<string, number>;
  /** UTC day → first finished seasons counted that day, last 30 days. */
  firstByDay: Record<string, number>;
  /** ISO-8601, or null when nothing has ever been counted. */
  updatedAt: string | null;
}

/** How many days of per-day tallies are kept. Older days are pruned on write. */
export const KEEP_DAYS = 30;

/** A sanity cap: a count past this is a hostile document, not a real board. */
export const MAX_COUNTER = 100_000_000;

/** The only day keys that are ever stored. */
export const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A fresh, empty counter block. A new object every call — never shared state. */
export const emptyRunStats = (): RunStats => ({
  runsFinished: 0,
  firstRuns: 0,
  byDay: {},
  firstByDay: {},
  updatedAt: null,
});

/** The UTC day a moment belongs to: what a day key means, in one place. */
export const utcDayKey = (at: Date): string => {
  try {
    return at.toISOString().slice(0, 10);
  } catch {
    return "1970-01-01";
  }
};

const count = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(MAX_COUNTER, Math.floor(n));
};

/**
 * A day map from anything: only real `YYYY-MM-DD` keys with a positive count
 * survive. Deliberately strict — this is also what keeps a hand-edited or
 * hostile document from turning the counters into a free-form junk store.
 */
const dayMap = (value: unknown): Record<string, number> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!DAY_KEY_PATTERN.test(key)) continue;
    const n = count(raw);
    if (n > 0) out[key] = n;
  }
  return out;
};

/** Prune to the KEEP_DAYS most recent day keys (keys sort chronologically). */
const pruneDays = (map: Record<string, number>): Record<string, number> => {
  const keys = Object.keys(map).sort();
  if (keys.length <= KEEP_DAYS) return map;
  const kept = keys.slice(-KEEP_DAYS);
  const out: Record<string, number> = {};
  for (const key of kept) out[key] = map[key] as number;
  return out;
};

const sumDays = (map: Record<string, number>): number =>
  Object.values(map).reduce((total, n) => (Number.isFinite(n) ? total + n : total), 0);

/**
 * Anything → counters. Never throws: a missing block is "nothing counted yet",
 * a nonsense one is repaired into numbers, and junk day keys are dropped.
 */
export const sanitizeRunStats = (value: unknown): RunStats => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return emptyRunStats();
  const raw = value as Record<string, unknown>;
  // A real timestamp or nothing: the renderers treat this as a date, and a
  // hand-edited "2026-08-40T…" must not reach one.
  const updated = isoStamp(raw.updatedAt);
  const byDay = pruneDays(dayMap(raw.byDay));
  const firstByDay = pruneDays(dayMap(raw.firstByDay));
  return {
    // A total is never reported below what the days add up to: the per-day
    // tallies are part of the same count, so a document that lost its totals
    // (but kept its days) is repaired rather than silently understated.
    runsFinished: Math.max(count(raw.runsFinished), sumDays(byDay)),
    firstRuns: Math.max(count(raw.firstRuns), sumDays(firstByDay)),
    byDay,
    firstByDay,
    updatedAt: updated,
  };
};

/** A timestamp, normalised to ISO — or null when it is not one. */
const isoStamp = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length === 0) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
};

/** Nothing has ever been counted here — used to tell "empty" from "degraded". */
export const runStatsAreEmpty = (stats: RunStats): boolean =>
  stats.runsFinished === 0 && stats.firstRuns === 0;

/**
 * ONE finished season. `first` is the client's own answer to "was this the first
 * season this browser has ever finished?", which it can read out of its own
 * storage and nowhere else. Pure: returns a new block, never mutates.
 */
export const addFinishedRun = (stats: RunStats, first: boolean, at: Date): RunStats => {
  const day = utcDayKey(at);
  const next: RunStats = {
    runsFinished: count(stats.runsFinished) + 1,
    firstRuns: count(stats.firstRuns) + (first ? 1 : 0),
    byDay: { ...stats.byDay, [day]: count(stats.byDay[day]) + 1 },
    firstByDay: first
      ? { ...stats.firstByDay, [day]: count(stats.firstByDay[day]) + 1 }
      : { ...stats.firstByDay },
    updatedAt: at.toISOString(),
  };
  return { ...next, byDay: pruneDays(next.byDay), firstByDay: pruneDays(next.firstByDay) };
};

/**
 * Keep the larger of two counter sets, field by field and day by day.
 *
 * This is the rule that makes a degraded read harmless: counters only grow, so
 * the biggest number ever seen is the one we keep. It is applied by the server
 * store against a process-lifetime high-water mark, and by tools/board-sync.sh
 * against the baked file before a publish (mirrored in Python there).
 */
export const mergeRunStats = (a: RunStats | null, b: RunStats | null): RunStats => {
  if (!a) return b ? sanitizeRunStats(b) : emptyRunStats();
  if (!b) return sanitizeRunStats(a);
  const left = sanitizeRunStats(a);
  const right = sanitizeRunStats(b);
  const byDay: Record<string, number> = { ...left.byDay };
  for (const [day, n] of Object.entries(right.byDay)) {
    byDay[day] = Math.max(byDay[day] ?? 0, n);
  }
  const firstByDay: Record<string, number> = { ...left.firstByDay };
  for (const [day, n] of Object.entries(right.firstByDay)) {
    firstByDay[day] = Math.max(firstByDay[day] ?? 0, n);
  }
  const stamps = [left.updatedAt, right.updatedAt].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return {
    runsFinished: Math.max(left.runsFinished, right.runsFinished, sumDays(byDay)),
    firstRuns: Math.max(left.firstRuns, right.firstRuns, sumDays(firstByDay)),
    byDay: pruneDays(byDay),
    firstByDay: pruneDays(firstByDay),
    updatedAt: stamps.length === 0 ? null : stamps.sort().slice(-1)[0] ?? null,
  };
};

/* -------------------------------------------------------------- the request */

/** `POST` here, and nowhere else. One bare boolean, nothing else. */
export const RUN_COUNT_PATH = "/api/run-count";

/** The read-only readout. */
export const STATS_PATH = "/api/stats";

/**
 * The request body: `{ first: true|false }` and nothing more.
 *
 * The strictness is the mitigation, not politeness: the endpoint counts runs
 * and cannot tell one caller from another (that is the point), so the cheapest
 * honest thing to do is refuse anything that is not exactly the one field we
 * know how to count.
 */
export const MAX_COUNT_BODY_BYTES = 200;

/** The body as the client sends it. One key, one boolean. */
export const countBody = (first: boolean): string => JSON.stringify({ first: first === true });

/**
 * A body → `true` (a first finished season), `false` (not a first), or null for
 * "this is not the request we count". Letters, in the strictest form we can
 * justify: a JSON object with exactly one own key, `first`, holding a boolean.
 */
export const parseCountBody = (body: string): boolean | null => {
  if (body.length === 0 || body.length > MAX_COUNT_BODY_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.length !== 1 || keys[0] !== "first") return null;
  if (typeof raw.first !== "boolean") return null;
  return raw.first;
};
