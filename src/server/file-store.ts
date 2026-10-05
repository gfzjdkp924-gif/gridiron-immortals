/**
 * Gridiron Immortals — the file-backed board store (SERVER ONLY).
 *
 * WHY THIS EXISTS: the boards waited on a Postgres connection string that the
 * owner cannot supply, so a finished season had nowhere to land. When no usable
 * connection string is set, the boards now fall back to this module: one JSON
 * document on the server's own disk, holding exactly what the database tables
 * hold. A usable connection string still wins — see src/server/leaderboard.ts
 * and src/server/player-board.ts, which only reach for this file when there is
 * no string at all or the string that is there cannot connect
 * (src/server/store-choice.ts).
 *
 * WHAT IT STORES — the same fields the schema stores, nothing more:
 *   runs    id, name, wins, losses, undefeated, overall, lineup, created_at
 *           (gridiron_runs: no device token, exactly as the table has none)
 *   players device_token, name, seasons, rating_sum, rating, wins, losses,
 *           best_wins, best_losses, best_overall, perfect_seasons,
 *           created_at, updated_at (gridiron_players: the per-identity
 *           aggregation, kept as a tally so the rating stays an average)
 *           — NOTE: `deviceToken` holds the ONE-WAY KEY of the device token,
 *           never the token itself (src/server/player-key.ts), in this file and
 *           in that table alike.
 *   stats   the ANONYMOUS finished-season counters (src/lib/run-stats.ts):
 *           runsFinished, firstRuns, byDay, firstByDay, updatedAt. Nothing here
 *           identifies anyone — see the doc comment on StoreDoc.stats.
 * The hashed caller key used for rate limiting is NEVER written here (or
 * anywhere): it lives in the process memory of src/server/leaderboard.ts for
 * ten minutes and is not part of the document below.
 *
 * WHERE THE FILE GOES — resolved by probing, never assumed (see `candidates`).
 * The first candidate is `<deploy root>/.data/board.json`, i.e. the document
 * lives INSIDE the deployed site tree — the same file as `.data/board.json` in
 * the team's workspace.
 *
 * DURABILITY, MEASURED (2026-10-04, live site, one publish between two reads of
 * a probe that seeded a marker into every candidate): nothing the running
 * process writes outlives a redeploy, because the next publish replaces the
 * deployment with a copy of the workspace tree. Every other candidate was
 * verified wiped at boot — `/home/team/.data/gridiron-immortals`, `/tmp/…`,
 * `$HOME/…`, `/var/tmp/…` all came back freshly seeded by the new process, and
 * `/data`, `/mnt/data`, `/srv/data` do not exist at all. The one directory
 * whose contents were carried across the redeploy unchanged was the deploy
 * root's own `.data`, because the tree (including it) is re-shipped.
 *
 * SO THE RULE IS THE OTHER WAY ROUND: the board is not kept by the server, it is
 * kept by US SHIPPING IT. Whatever is in the workspace `.data/board.json` when a
 * publish runs becomes the board's base state on the next deployment
 * (`adoptShippedBase` reads that file back when the store file itself is absent
 * or unreadable), and the "carry forward" step is a sync of the CURRENT live
 * board into that file just before publishing — `tools/board-sync.sh`, run by
 * whoever publishes. A season is therefore durable across a redeploy, but it is
 * durable in whole publishes, not continuously: a season posted between the sync
 * and the deploy is on the board until that deploy lands, then comes back with
 * the next sync (the player's own copy of the run also stays on their device).
 *
 * The store file may hold a device's players-board identity only as a one-way
 * hash — see src/server/player-key.ts, and `rekeyPlayerRows` below.
 *
 * NEVER CRASHES: a missing, empty, truncated or corrupt document reads as an
 * empty board; a directory that cannot be written reports "not connected" (the
 * same state the boards showed before this module existed); every filesystem
 * call is wrapped and time-bounded, so no request can hang on a stuck mount.
 *
 * AND A DEGRADED READ CAN NEVER ZERO THE COUNTERS. Counters only ever grow, so
 * three rules protect them, and all three are needed: (1) a document that fails
 * to parse is scanned for a still-readable `"stats"` block and keeps it
 * (`salvageStats`), (2) every write is merged with a process-lifetime high-water
 * mark (`mergeRunStats`), so the moment after a degraded read cannot write
 * zeros over numbers, and (3) the carry-forward step that puts the live board
 * back into the shipped file merges the same way instead of replacing
 * (tools/board-sync.sh). A counter is data we cannot re-derive: a lost season is
 * a lost run, more honestly reported than silently discounted.
 *
 * ATOMIC AND SERIALISED: every read-modify-write runs through one in-process
 * queue, and each write goes to a temp file which is fsync'd and then renamed
 * over the target, so two simultaneous submissions can neither lose nor
 * half-write an entry. Two *processes* sharing one directory (only possible
 * during the brief overlap of a redeploy) each write whole documents; the
 * later writer's document wins.
 */
import { randomUUID } from "node:crypto";
import { existsSync, type Stats } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { LineupPick } from "~/lib/leaderboard";
import {
  emptyRunStats,
  mergeRunStats,
  runStatsAreEmpty,
  sanitizeRunStats,
  type RunStats,
} from "~/lib/run-stats";
import { isPlayerKey, rekeyPlayerRows } from "~/server/player-key";

/** Bumped only if the document's shape changes incompatibly. */
export const STORE_VERSION = 1;
export const STORE_FILE_NAME = "board.json";

/** One completed season, in the shape gridiron_runs stores it. */
export interface StoredRun {
  id: number;
  name: string;
  wins: number;
  losses: number;
  undefeated: boolean;
  overall: number;
  lineup: LineupPick[];
  /**
   * The ONE-WAY KEY of the device token that posted this run
   * (src/server/player-key.ts), exactly as `gridiron_runs.player_key` and a
   * players-board row hold it — never the token. It is what makes a profile
   * possible: a device can read back its own seasons by key, so two phones that
   * both post as "John" stay two players. Null for a run posted before the key
   * existed: an unattributable run belongs to no profile rather than to a guess.
   */
  playerKey: string | null;
  /** ISO-8601, like a timestamptz read back as text. */
  createdAt: string;
}

/** One identity's tally, in the shape gridiron_players stores it. */
export interface StoredPlayer {
  deviceToken: string;
  name: string;
  seasons: number;
  /** The exact total behind `rating` — the average is never re-derived lossily. */
  ratingSum: number;
  rating: number;
  wins: number;
  losses: number;
  bestWins: number;
  bestLosses: number;
  bestOverall: number;
  perfectSeasons: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoreDoc {
  version: number;
  /** Next free run id — monotonic, so the board's id tiebreak stays total. */
  nextId: number;
  runs: StoredRun[];
  players: StoredPlayer[];
  /**
   * THE ANONYMOUS FINISHED-SEASON COUNTERS (src/lib/run-stats.ts), kept HERE, in
   * the board document, rather than in a file of their own: this document is the
   * one thing a publish carries forward (tools/board-sync.sh), so a separate
   * file's counters would be wiped by the next redeploy. They count RUNS, never
   * people — no field here is tied to a device, a name or an address. The key is
   * optional on load (a document written before the counters existed has none)
   * and always present on write.
   */
  stats: RunStats;
}

/**
 * Generous caps. They exist so a corrupted or hostile document cannot make the
 * server allocate without bound; a real board is nowhere near them.
 */
const MAX_RUNS = 10_000;
const MAX_PLAYERS = 10_000;
/** A document past this size is not read at all (treated as empty). */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** No filesystem operation may hold a request longer than this. */
export const OP_TIMEOUT_MS = 5_000;
/** How long a failed resolution is trusted before it is tried again. */
const REPROBE_MS = 15_000;

/* -------------------------------------------------------- directory choice */

interface Candidate {
  dir: string;
  /** Named in logs and in /api/env-check, so a deployment can be diagnosed. */
  source: string;
  /** How long this location is likely to live — worth knowing when reading logs. */
  note: string;
}

/**
 * Where the document may live, best first.
 *
 * FIRST: the deploy root's own `.data` directory — the deployed site tree, which
 * is the only place whose contents are carried across a redeploy (measured
 * 2026-10-04; see the header). This is the same directory as `.data` in the
 * team's workspace, so the document is shipped with every publish and is what
 * `tools/board-sync.sh` keeps current. It is writable on the live runtime, the
 * deploy root is the process's working directory, and `.data` is never publicly
 * served (serve.ts serves static files out of dist/client only).
 *
 * THEN: the platform's team data directory. Measured wiped by every redeploy, so
 * it is a fallback that keeps the board alive mid-session rather than a home for
 * the data — it is only reached when the deploy tree cannot be written at all.
 * LAST: the temporary directory, which is known not to survive even a restart.
 *
 * A `GRIDIRON_DATA_DIR` (or `DATA_DIR`) environment variable wins over all of
 * them, so a future runtime that offers a real volume can be pointed at it
 * without a code change (and the test harness in tools/file-board-check.ts uses
 * it to keep its own document away from the real one).
 */
const candidates = (): Candidate[] => {
  const list: Candidate[] = [];
  const explicit = (process.env.GRIDIRON_DATA_DIR ?? "").trim();
  if (explicit) {
    list.push({ dir: explicit, source: "env:GRIDIRON_DATA_DIR", note: "operator-chosen" });
  } else {
    const generic = (process.env.DATA_DIR ?? "").trim();
    if (generic) list.push({ dir: generic, source: "env:DATA_DIR", note: "operator-chosen" });
  }
  const root = projectRoot();
  list.push({
    dir: join(root, ".data"),
    source: "deploy",
    note: "inside the deployed site tree — shipped with every publish, so it is carried forward",
  });
  list.push({
    dir: platformDataDir(),
    source: "platform:/home/team/.data",
    note: "platform data directory — wiped by every redeploy (measured 2026-10-04), fallback only",
  });
  list.push({
    dir: join(tmpdir(), "gridiron-immortals"),
    source: "tmp",
    note: "temporary directory — does NOT survive a restart",
  });
  const seen = new Set<string>();
  return list.filter((candidate) => {
    if (seen.has(candidate.dir)) return false;
    seen.add(candidate.dir);
    return true;
  });
};

/**
 * The deploy root: the nearest ancestor of the working directory that looks
 * like the project (`package.json` or `site.json`), else the working directory
 * itself. Deliberately not `import.meta.dir`: in the built server that points
 * inside the build output, which is replaced on every publish.
 */
const projectRoot = (): string => {
  let dir = process.cwd();
  for (let depth = 0; depth < 4; depth++) {
    if (existsSync(join(dir, "package.json")) || existsSync(join(dir, "site.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
};

/**
 * The directory candidates, in preference order — private on purpose. It was
 * exported for a temporary durability probe (src/routes/api/persist-probe.ts,
 * deleted once the measurement above was in), and nothing else may depend on the
 * store's internal search order.
 */

interface ResolvedStore {
  dir: string;
  file: string;
  source: string;
  note: string;
}

let resolved: ResolvedStore | null = null;
let resolving: Promise<ResolvedStore | null> | null = null;
let failedAt = 0;

/** A directory counts as usable only when a real file can be written into it. */
const writable = async (dir: string): Promise<boolean> => {
  const probe = join(dir, `.write-probe-${process.pid}-${randomUUID().slice(0, 8)}`);
  try {
    await mkdir(dir, { recursive: true });
    const handle = await open(probe, "w");
    try {
      await handle.writeFile("ok");
    } finally {
      await handle.close();
    }
    await unlink(probe).catch(() => undefined);
    return true;
  } catch {
    await unlink(probe).catch(() => undefined);
    return false;
  }
};

const pick = async (): Promise<ResolvedStore | null> => {
  for (const candidate of candidates()) {
    if (!(await writable(candidate.dir))) continue;
    resolved = {
      dir: candidate.dir,
      file: join(candidate.dir, STORE_FILE_NAME),
      source: candidate.source,
      note: candidate.note,
    };
    console.log(`[store] file-backed board at ${resolved.file} (${candidate.source}) — ${candidate.note}`);
    return resolved;
  }
  console.error("[store] no writable directory for the board file — the boards report 'not connected'");
  return null;
};

/**
 * Read one file with NO logging and no side effects: used only while looking for
 * a base state to adopt. null means "nothing usable here" for any reason.
 */
const readQuiet = async (file: string): Promise<StoreDoc | null> => {
  try {
    const info = await bounded<Stats | null>(stat(file), null);
    if (!info || !info.isFile() || info.size === 0 || info.size > MAX_FILE_BYTES) return null;
    const raw = await bounded<string | null>(readFile(file, "utf8"), null);
    if (raw === null) return null;
    return normalize(JSON.parse(raw));
  } catch {
    return null;
  }
};

/** Once per process: a seed is a start-up step, never something a request repeats. */
let seeded = false;

/**
 * SEED ON BOOT. The document in the deployed tree IS the board's base state: it
 * is written by the running game and re-shipped by the next publish (see the
 * header). This step covers the two ways that base can be missing rather than
 * present — the store file is not there at all (a first deploy, a publish that
 * did not carry `.data`, a host that cleaned the tree), or it is there but
 * unreadable (truncated, corrupt, empty) — by adopting the best document it can
 * find in the other candidate directories instead of starting an empty board.
 *
 * Deliberately conservative, because the wrong seed would resurrect older data
 * over newer data:
 *   - it runs ONLY for the DEPLOY-TREE store (the source is `deploy`). A store an
 *     operator pointed somewhere with GRIDIRON_DATA_DIR is left alone: a chosen
 *     directory must not quietly pick up a document from somewhere else, and the
 *     test harness relies on exactly that isolation;
 *   - it runs ONLY when the resolved file is ABSENT or UNREADABLE (missing,
 *     empty, truncated, corrupt). A document that reads back — even one that
 *     holds nothing at all, which is a deliberately empty board — IS the base
 *     state and is never replaced, so a board wiped on purpose stays wiped;
 *   - it then takes the FIRST candidate that holds a non-empty document, in the
 *     same preference order the store itself uses;
 *   - it never touches a candidate directory — reads only.
 * Everything it does is a normal atomic write, so a reader sees either the
 * previous state or the seeded one, and a seed that fails is simply skipped (the
 * board then starts empty, exactly as it did before this step existed).
 */
const adoptShippedBase = async (found: ResolvedStore): Promise<void> => {
  if (seeded) return;
  seeded = true;
  if (found.source !== "deploy") return;
  // A readable document — even an empty one — is the base state: nothing to adopt.
  if ((await readQuiet(found.file)) !== null) return;
  for (const candidate of candidates()) {
    if (candidate.dir === found.dir) continue;
    const file = join(candidate.dir, STORE_FILE_NAME);
    const doc = await readQuiet(file);
    if (!doc || (doc.runs.length === 0 && doc.players.length === 0 && runStatsAreEmpty(doc.stats))) {
      continue;
    }
    if (!(await writeAtomic(found, doc))) return;
    console.log(
      `[store] seeded the board at ${found.file} from ${file} (${String(doc.runs.length)} runs, ${String(doc.players.length)} players) — the deployed copy had no readable document`,
    );
    return;
  }
  console.log(`[store] no readable document at ${found.file} and none to seed from — starting an empty board`);
};

/**
 * The store's location, or null when nothing is writable. Memoised for the life
 * of the process; a failed resolution is retried after REPROBE_MS rather than on
 * every request, and a failed WRITE clears the memo so the next request
 * re-probes (a read-only mount that comes back read-write starts working with
 * no redeploy). Resolving the location also runs the one-off seed-on-boot step.
 */
/**
 * The platform's own team data directory. It is a FALLBACK and nothing more:
 * measured 2026-10-04, every redeploy starts it empty, so it can keep a board
 * alive within one deployment but can never be the board's base state.
 * `GRIDIRON_PLATFORM_DATA_DIR` exists for exactly one reason — so the test
 * harness can keep its fixtures away from a real directory on a shared machine.
 * Nothing in the game sets it.
 */
const platformDataDir = (): string =>
  (process.env.GRIDIRON_PLATFORM_DATA_DIR ?? "").trim() || "/home/team/.data/gridiron-immortals";

const store = async (): Promise<ResolvedStore | null> => {
  if (resolved) return resolved;
  if (failedAt && Date.now() - failedAt < REPROBE_MS) return null;
  if (!resolving) {
    resolving = pick()
      .then(async (picked) => {
        if (!picked) {
          failedAt = Date.now();
          return null;
        }
        // Inside the resolution, so a seed can never race a second resolution.
        try {
          await adoptShippedBase(picked);
        } catch (error: unknown) {
          console.error(
            `[store] could not seed the board: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return picked;
      })
      .catch(() => {
        failedAt = Date.now();
        return null;
      })
      .finally(() => {
        resolving = null;
      });
  }
  return resolving;
};

/** Forget the resolved location so the next call re-probes. */
const invalidate = (): void => {
  resolved = null;
  failedAt = Date.now();
};

/** Diagnostics for /api/env-check and the server log. Never touches a secret. */
export const describeStore = async (): Promise<{
  kind: "file" | "none";
  source: string | null;
  dir: string | null;
  file: string | null;
  note: string | null;
}> => {
  const found = await store();
  if (!found) return { kind: "none", source: null, dir: null, file: null, note: null };
  return { kind: "file", source: found.source, dir: found.dir, file: found.file, note: found.note };
};

/** True when a board write can be stored. Cheap: the probe is memoised. */
export const storeAvailable = async (): Promise<boolean> => (await store()) !== null;

/* ---------------------------------------------------------- serialisation */

/**
 * One queue for the whole process: every read and every write of the document
 * runs through it, so a read-modify-write can never interleave with another
 * one. A rejected task never breaks the chain (the next task runs regardless).
 */
let chain: Promise<unknown> = Promise.resolve();

/** Serialise `task` behind every board operation already queued. */
export const withStoreLock = <T>(task: () => Promise<T>): Promise<T> => {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

/* -------------------------------------------------------------------- read */

const num = (value: unknown, fallback = 0): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const int = (value: unknown, fallback = 0): number => {
  const n = num(value, Number.NaN);
  return Number.isInteger(n) ? n : fallback;
};

/** Free text, clamped — the same discipline cleanName() applies on the way in. */
const text = (value: unknown, max: number, fallback = ""): string =>
  typeof value === "string" ? value.slice(0, max) : fallback;

/**
 * A timestamp the renderer can survive. `mapBoardRow` calls
 * `.toISOString()`, which THROWS on an invalid date, so a hand-edited file
 * must not be able to hand it one.
 */
const iso = (value: unknown, fallback: string): string => {
  const date = new Date(typeof value === "string" || typeof value === "number" ? value : Number.NaN);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
};

const sanitizeRun = (raw: unknown, fallbackTime: string): StoredRun | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = int(r.id, 0);
  if (id <= 0) return null;
  const wins = Math.min(17, Math.max(0, int(r.wins, 0)));
  // Only a real key is kept. A hand-edited document (or one from an older
  // revision) must never be able to leave a device TOKEN in a run row: anything
  // that is not the 64-character one-way hash is treated as no identity at all.
  const rawKey = text(r.playerKey ?? r.player_key, 64);
  return {
    id,
    name: text(r.name, 64, "—") || "—",
    wins,
    losses: Math.min(17, Math.max(0, int(r.losses, 17 - wins))),
    // Derived on the way in, so it is derived on the way out too.
    undefeated: wins >= 17,
    overall: num(r.overall, 0),
    lineup: Array.isArray(r.lineup) ? (r.lineup as LineupPick[]) : [],
    playerKey: isPlayerKey(rawKey) ? rawKey : null,
    createdAt: iso(r.createdAt ?? r.created_at, fallbackTime),
  };
};

const sanitizePlayer = (raw: unknown, fallbackTime: string): StoredPlayer | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const deviceToken = text(r.deviceToken ?? r.device_token, 64);
  if (deviceToken.length === 0) return null;
  const seasons = Math.max(0, int(r.seasons, 0));
  const rating = num(r.rating, 0);
  return {
    deviceToken,
    name: text(r.name, 64, "—") || "—",
    seasons,
    // A document without rating_sum (or one claiming a nonsense sum) is repaired
    // into something the average can still be computed from.
    ratingSum: num(r.ratingSum ?? r.rating_sum, rating * seasons),
    rating,
    wins: Math.max(0, int(r.wins, 0)),
    losses: Math.max(0, int(r.losses, 0)),
    bestWins: Math.max(0, int(r.bestWins ?? r.best_wins, 0)),
    bestLosses: Math.max(0, int(r.bestLosses ?? r.best_losses, 0)),
    bestOverall: num(r.bestOverall ?? r.best_overall, 0),
    perfectSeasons: Math.max(0, int(r.perfectSeasons ?? r.perfect_seasons, 0)),
    createdAt: iso(r.createdAt ?? r.created_at, fallbackTime),
    updatedAt: iso(r.updatedAt ?? r.updated_at, fallbackTime),
  };
};

export const emptyDoc = (): StoreDoc => ({
  version: STORE_VERSION,
  stats: emptyRunStats(),
  nextId: 1,
  runs: [],
  players: [],
});

/** A loaded document, normalised. Malformed rows are dropped, never thrown on. */
const normalize = (raw: unknown): StoreDoc | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.runs) || !Array.isArray(r.players)) return null;
  const now = new Date().toISOString();
  const runs = r.runs
    .map((run) => sanitizeRun(run, now))
    .filter((run): run is StoredRun => run !== null)
    .slice(-MAX_RUNS);
  const players = r.players
    .map((player) => sanitizePlayer(player, now))
    .filter((player): player is StoredPlayer => player !== null)
    .slice(-MAX_PLAYERS);
  // A row written before the key scheme holds a raw device token; its key is
  // derivable from the value itself, so it is re-keyed here — once, on load, and
  // only in memory. Every later write (and the export at /api/board-export)
  // therefore leaves this store holding hashes and never a device token. See
  // src/server/player-key.ts.
  rekeyPlayerRows(players);
  const highest = runs.reduce((max, run) => Math.max(max, run.id), 0);
  return {
    version: STORE_VERSION,
    // The counters go NEAR THE FRONT of the written document on purpose: this
    // order is the one that leaves `"stats"` intact if a document is ever
    // truncated, which is the case `salvageStats` exists to read.
    // Absent in a document written before the counters existed — which is an
    // honest "nothing counted yet", not a degraded read.
    stats: sanitizeRunStats(r.stats),
    nextId: Math.max(highest + 1, int(r.nextId, 1), 1),
    runs,
    players,
  };
};

/* ------------------------------------------------------------ the counters */

/**
 * The largest counter set THIS PROCESS has ever seen, merged into every write.
 *
 * Why it is needed at all: `read` deliberately answers an unreadable document
 * with an empty board, and a season posted in that moment would otherwise write
 * the empty counters back over real ones. Counters only ever grow, so the
 * high-water mark is the honest floor for any write — and it costs one merge per
 * request. It is a belt to the sync's braces (tools/board-sync.sh merges the
 * live board into the shipped file the same way) and it is deliberately
 * process-local: a redeploy starts it from zero and the document itself is then
 * the only truth, which is exactly what the carry-forward step exists for.
 */
let statsHighWater: RunStats | null = null;

const rememberStats = (stats: RunStats): void => {
  statsHighWater = mergeRunStats(statsHighWater, stats);
};

/**
 * The counters still readable inside a document we could not parse.
 *
 * A truncated or half-written document is a real failure mode (a killed process
 * mid-write, a full disk), and the counters are the part we cannot re-derive:
 * the runs and ratings are also on the players' devices, while a finished season
 * that was never posted exists nowhere else. So the raw text is scanned for the
 * `"stats"` object — the document is written by this module as compact JSON, so
 * its block is intact even when the tail is not — and whatever survives is kept.
 * A bounded, quote-aware brace scan; nothing here is trusted before
 * `sanitizeRunStats` has had it. null means "nothing salvageable".
 */
const salvageStats = (raw: string): RunStats | null => {
  try {
    const at = raw.indexOf('"stats"');
    if (at < 0) return null;
    const start = raw.indexOf("{", at + 7);
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    const limit = Math.min(raw.length, start + 20_000);
    for (let i = start; i < limit; i += 1) {
      const ch = raw[i] as string;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const stats = sanitizeRunStats(JSON.parse(raw.slice(start, i + 1)));
          return runStatsAreEmpty(stats) ? null : stats;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
};

/**
 * A document we could not use: an empty board, but with anything salvageable
 * from the broken text kept — the counters in particular, because losing them is
 * not recoverable from anywhere else (see the module header).
 */
const degraded = (found: ResolvedStore, raw: string | null, why: string): StoreDoc => {
  const salvaged = raw === null ? null : salvageStats(raw);
  // Merged with the high-water mark, so the counters a read reports can never be
  // smaller than the ones this process has already seen.
  const stats = mergeRunStats(salvaged, statsHighWater);
  if (salvaged) rememberStats(salvaged);
  console.error(
    `[store] could not read ${found.file} (${why}) — treating the board as empty${
      runStatsAreEmpty(stats)
        ? ""
        : `; keeping the counters this process has seen (${String(stats.runsFinished)} finished, ${String(stats.firstRuns)} first)`
    }`,
  );
  return { ...emptyDoc(), stats };
};

/**
 * "No document here": an empty board whose counters are still the largest this
 * process has ever seen. A file that is missing, empty or too large to read is
 * not evidence that nothing was ever counted, and reporting zeros would read
 * like a season that never happened — so the counters ride on the high-water
 * mark until something on disk says otherwise. Everything else is genuinely
 * empty, exactly as it was before the counters existed.
 */
const emptyBoard = (): StoreDoc => ({ ...emptyDoc(), stats: statsHighWater ?? emptyRunStats() });

/** Bound a filesystem promise so a stuck mount can never hold a request open. */
const bounded = async <T>(promise: Promise<T>, fallback: T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          resolve(fallback);
        }, OP_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * The document. NEVER returns null: the store was resolved only after a
 * successful write probe in that directory, so a file that is not there yet
 * simply means an empty board (and the first write creates it). A missing file,
 * an empty file, a truncated file and a corrupt one are therefore all "an empty
 * board" — never an error, and never a half-read document.
 */
const read = async (found: ResolvedStore): Promise<StoreDoc> => {
  try {
    const info = await bounded<Stats | null>(stat(found.file), null);
    if (!info) return emptyBoard();
    if (!info.isFile()) {
      console.error(`[store] ${found.file} is not a file — treating the board as empty`);
      return emptyBoard();
    }
    if (info.size === 0) return emptyBoard();
    if (info.size > MAX_FILE_BYTES) {
      console.error(
        `[store] ${found.file} is ${String(info.size)} bytes — too large to read, treating the board as empty`,
      );
      return emptyBoard();
    }
    const raw = await bounded<string | null>(readFile(found.file, "utf8"), null);
    if (raw === null) return emptyBoard();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Truncated or corrupt JSON lands here. Empty board, never an error, but
      // the counters still readable in the broken text are kept (`degraded`).
      return degraded(found, raw, "it is not readable JSON");
    }
    const doc = normalize(parsed);
    if (!doc) return degraded(found, raw, "it is not a board document");
    // A document that READ is the truth for this process's high-water mark.
    rememberStats(doc.stats);
    return doc;
  } catch (error: unknown) {
    return degraded(found, null, error instanceof Error ? error.message : String(error));
  }
};

/**
 * Read the document for a READ path: null means "no usable store" (the boards
 * then say they are not connected). Serialised with writes so a reader never
 * sees a half-written document.
 */
export const readDocument = (): Promise<StoreDoc | null> =>
  withStoreLock(async () => {
    const found = await store();
    if (!found) return null;
    return read(found);
  });

/**
 * Read, change, then atomically replace the document for a WRITE path. Returns
 * the document as written, or null when there is nowhere to write it (the
 * caller then reports its honest "not connected"). The read happens INSIDE the
 * queue, so no second request can slip between the read and the write.
 */
export const updateDocument = (
  mutate: (doc: StoreDoc) => StoreDoc | null,
): Promise<StoreDoc | null> =>
  withStoreLock(async () => {
    const found = await store();
    if (!found) return null;
    const current = await read(found);
    const next = mutate(JSON.parse(JSON.stringify(current)) as StoreDoc);
    if (!next) return null;
    // THE COUNTERS NEVER SHRINK: whatever the read above could see, this write
    // still carries the largest counter set this process has ever observed, so a
    // degraded read cannot be the moment the numbers are lost. See
    // `statsHighWater` and the module header.
    next.stats = mergeRunStats(next.stats, statsHighWater);
    const written = await writeAtomic(found, next);
    if (!written) {
      invalidate();
      return null;
    }
    rememberStats(next.stats);
    return next;
  });

/**
 * Temp file → fsync → rename. The rename is the moment the new document becomes
 * the board: a reader therefore sees either the whole previous document or the
 * whole new one, never a partial write. The fsync is best-effort — a filesystem
 * that does not support it must not cost us the write.
 */
const writeAtomic = async (found: ResolvedStore, doc: StoreDoc): Promise<boolean> => {
  const temp = `${found.file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    await mkdir(found.dir, { recursive: true });
    const handle = await open(temp, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(doc)}\n`, "utf8");
      await handle.sync().catch(() => undefined);
    } finally {
      await handle.close();
    }
    await rename(temp, found.file);
    return true;
  } catch (error: unknown) {
    console.error(
      `[store] could not write ${found.file}: ${error instanceof Error ? error.message : String(error)} — the board reports 'not connected'`,
    );
    await unlink(temp).catch(() => undefined);
    return false;
  }
};

/** Where the document would live, for the server log — no probe, no write. */
export const storeDirHint = (): string => resolved?.dir ?? candidates()[0]?.dir ?? "unresolved";
