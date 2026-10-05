/**
 * Gridiron Immortals — the file-backed board store, checked for real.
 *
 *   bun tools/file-board-check.ts
 *
 * Runs the boards in-process against the file store (no connection string in
 * the environment), then re-runs the awkward cases in child processes, because
 * a couple of them can only be observed once per process:
 *
 *   main          several runs posted, ranked order, the undefeated filter,
 *                 one identity's 3+ seasons folded into a rating, reload
 *   rate-limit    the write limit is still 8 per caller per 10 minutes
 *   corrupt       a garbage document reads as an empty board and repairs itself
 *   unwritable    no writable directory anywhere → honest "not connected"
 *   precedence    a connection string that CANNOT connect falls back to the
 *                 file store (the rule shipped 2026-10-04: a broken secret must
 *                 never take the boards down), and a reachable Postgres still
 *                 wins outright — that half runs as `precedence-db`, its own
 *                 process, because a failed connection is cached as a 60s
 *                 cooldown (POSTGRES_RETRY_MS in src/server/store-choice.ts).
 *                 `precedence-db` needs a real Postgres on 127.0.0.1:5432 with
 *                 a database named `gridiron_precedence`.
 *
 * The tool never touches the deployment's own document: every mode points
 * GRIDIRON_DATA_DIR at a fresh temporary directory and deletes it afterwards.
 */
import { mkdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describeDb } from "~/db";
import { PLAYERS } from "~/data/players";
import type { LineupPick } from "~/lib/leaderboard";
import { MIN_SEASONS } from "~/lib/player-rating";
import { ROSTER_SLOTS, SEASON_GAMES } from "~/lib/rating";
import { describeStore } from "~/server/file-store";
import { readBoard, submitRun } from "~/server/leaderboard";
import { playerKey } from "~/server/player-key";
import { readPlayersBoard } from "~/server/player-board";

/* ------------------------------------------------------------------ harness */

let failures = 0;
let checks = 0;

const check = (name: string, ok: boolean, detail?: unknown): void => {
  checks += 1;
  if (ok) {
    console.log(`  PASS  ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
};

const mode = Bun.argv.find((arg) => arg.startsWith("--mode="))?.slice("--mode=".length) ?? "main";
const DIR = process.env.CHECK_DIR ?? join(tmpdir(), `gridiron-check-${mode}-${process.pid}`);
/** deploy-child runs WITHOUT the override on purpose: it must resolve the store
 *  the way a real deployment does, from its own working directory. */
const RESOLVES_ITS_OWN_STORE = ["deploy-child", "deploy-child-empty", "deploy-locked-child"];
if (!RESOLVES_ITS_OWN_STORE.includes(mode)) process.env.GRIDIRON_DATA_DIR = DIR;
delete process.env.DATABASE_URL;
delete process.env.NEON_DATABASE_URL;
delete process.env.POSTGRES_URL;

const FILE = join(DIR, "board.json");

/** A real 11-man lineup: the best (or worst) pool player at every slot. */
const lineupFor = (tier: "strong" | "weak"): LineupPick[] => {
  const used = new Set<string>();
  const picks: LineupPick[] = [];
  for (const def of ROSTER_SLOTS) {
    const candidates = PLAYERS.filter(
      (player) => player.position === def.position && !used.has(player.name.trim().toLowerCase()),
    ).sort((a, b) => (tier === "strong" ? b.rating - a.rating : a.rating - b.rating));
    const player = candidates[0];
    if (!player) throw new Error(`no pool player for slot ${def.slot}`);
    used.add(player.name.trim().toLowerCase());
    picks.push({
      slot: def.slot,
      name: player.name,
      position: player.position,
      team: player.team,
      decade: player.decade,
      rating: player.rating,
    });
  }
  return picks;
};

const STRONG = lineupFor("strong");
const WEAK = lineupFor("weak");

const body = (
  name: string,
  wins: number,
  lineup: LineupPick[],
  deviceToken?: string,
): Record<string, unknown> => ({
  name,
  wins,
  losses: SEASON_GAMES - wins,
  lineup,
  ...(deviceToken === undefined ? {} : { deviceToken }),
});

const post = async (label: string, payload: Record<string, unknown>, caller: string) => {
  const outcome = await submitRun(payload, caller);
  check(`${label} accepted`, outcome.ok === true, outcome.ok ? undefined : outcome.error);
  return outcome;
};

const runChild = (childMode: string, storeDir = join(tmpdir(), `gridiron-check-${childMode}-${Date.now()}`)): number => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, import.meta.path, `--mode=${childMode}`],
    // The child uses the SAME store directory when one is given, which is how
    // "a fresh process reads the board back" is actually tested.
    env: { ...process.env, CHECK_DIR: storeDir },
    stdout: "inherit",
    stderr: "inherit",
  });
  return result.exitCode ?? 1;
};

/* -------------------------------------------------------------------- modes */

const TOKEN_GRINDER = "abcdef0123456789abcdef0123456789";
const TOKEN_SOLO = "0123456789abcdef0123456789abcdef";

const main = async (): Promise<void> => {
  console.log(`file store at ${FILE}\n`);

  /* 1. an empty board, before anything is posted */
  const before = await readBoard();
  check("empty board is connected (not 'not connected')", before.connected === true, before);
  check("empty board has no entries and no total", before.entries.length === 0 && before.total === 0);
  const playersBefore = await readPlayersBoard(null);
  check("empty players board is connected", playersBefore.connected === true);
  check("empty players board has no identities", playersBefore.identities === 0 && playersBefore.entries.length === 0);
  check("players board still publishes its tier table", playersBefore.tiers.length === 5);

  /* 2. post several runs: a 17-0, a 12-5 pair split by roster quality, and one
        identity posting three seasons */
  const ace = await post("17-0 'Ace'", body("Ace", 17, STRONG, TOKEN_SOLO), "check-ace");
  check("the 17-0 run is flagged undefeated", ace.ok && ace.entry.undefeated === true);
  check("the 17-0 run is rank 1", ace.ok && ace.rank === 1, ace.ok ? ace.rank : ace);
  check(
    "the run carries the pool-recomputed overall, not a client number",
    ace.ok && ace.entry.overall > 0 && ace.entry.overall < 100,
    ace.ok ? ace.entry.overall : ace,
  );

  await post("15-2 'Brick'", body("Brick", 15, STRONG, TOKEN_GRINDER), "check-brick");
  await post("12-5 'Tie High' (strong roster)", body("Tie High", 12, STRONG, TOKEN_GRINDER), "check-tie-hi");
  await post("12-5 'Tie Low' (weak roster)", body("Tie Low", 12, WEAK), "check-tie-lo");
  await post("9-8 'Grinder' season 1", body("Grinder", 9, STRONG, TOKEN_GRINDER), "check-g1");
  await post("0-17 'Zero'", body("Zero", 0, WEAK), "check-zero");
  await post("3-14 'Grinder' season 3", body("Grinder", 3, WEAK, TOKEN_GRINDER), "check-g3");

  const board = await readBoard();
  check("board reports every stored run", board.total === 7, board.total);
  check("board returns them all (under the 100 cap)", board.entries.length === 7);

  const names = board.entries.map((entry) => entry.name);
  check(
    "ranked order is wins first, then roster rating",
    JSON.stringify(names.slice(0, 4)) === JSON.stringify(["Ace", "Brick", "Tie High", "Tie Low"]),
    names,
  );
  const tieHi = board.entries.findIndex((entry) => entry.name === "Tie High");
  const tieLo = board.entries.findIndex((entry) => entry.name === "Tie Low");
  check(
    "equal wins break on the better roster",
    tieHi >= 0 && tieLo >= 0 && tieHi < tieLo && board.entries[tieHi]!.overall > board.entries[tieLo]!.overall,
    { tieHi, tieLo },
  );
  check(
    "ranks are 1..n in order",
    board.entries.every((_, index) => index === 0 || board.entries[index]!.wins <= board.entries[index - 1]!.wins),
  );
  check(
    "the lineup round-trips with its slots",
    board.entries[0]!.lineup.length === 11 && typeof board.entries[0]!.lineup[0]!.slot === "string",
  );
  check(
    "createdAt is a valid ISO timestamp",
    !Number.isNaN(new Date(board.entries[0]!.createdAt).getTime()),
  );

  /* 3. the undefeated filter the leaderboard page applies */
  const perfectOnly = board.entries.filter((entry) => entry.undefeated);
  check(
    "the undefeated filter shows exactly the 17-0 runs",
    perfectOnly.length === 1 && perfectOnly[0]!.name === "Ace",
    perfectOnly.map((entry) => entry.name),
  );

  /* 4. the players board aggregation for the identity with three seasons */
  const players = await readPlayersBoard(TOKEN_GRINDER);
  check("players board is connected", players.connected === true);
  const mine = players.entries.find((row) => row.you);
  check("the multi-season identity is on the board and flagged as the caller's", mine !== undefined);
  check("that identity has 4 seasons (3+ as required)", mine?.seasons === 4, mine?.seasons);
  // Board ROWS carry no `qualified` flag — being on the board IS the qualification
  // (the query filters seasons >= MIN_SEASONS), exactly as the Postgres path does.
  check("only qualified identities are on the board", players.total === 1 && players.entries.length === 1, players.total);
  check("every identity is still counted", players.identities === 2, players.identities);
  check("its record is the running total (15+12+9+3, 2+5+8+14)", mine?.wins === 39 && mine?.losses === 29, mine);
  check("its best season is 15-2", mine?.bestWins === 15 && mine?.bestLosses === 2);
  check("its best roster is the strongest lineup it posted", mine?.bestOverall === 97, mine?.bestOverall);
  check("its rating is an average in the rating range", (mine?.rating ?? 0) > 200 && (mine?.rating ?? 0) < 2000, mine?.rating);
  check("it has a board rank and a tier", (mine?.rank ?? 0) >= 1 && typeof mine?.tier === "string", mine);
  const grinder = await readPlayersBoard(TOKEN_GRINDER);
  const mineAgain = grinder.entries.find((row) => row.you);
  check(
    "a second read returns the identical rating (persisted, not recomputed)",
    mineAgain?.rating === mine?.rating && mineAgain?.seasons === mine?.seasons,
  );

  /* an identity below the gate is shown to itself, rank null */
  const solo = await readPlayersBoard(TOKEN_SOLO);
  check("a one-season identity is told how many seasons it still needs", solo.you?.seasonsToQualify === MIN_SEASONS - 1, solo.you);
  check("and has no rank yet", solo.you?.rank === null && solo.you?.qualified === false);
  const soloBoard = await readPlayersBoard(null);
  check("but is NOT on the public board", soloBoard.entries.every((row) => !row.you) && soloBoard.identities === 2);
  check("anonymous read has no 'you' standing", soloBoard.you === null);

  /* 5. the document holds no hashed IP, and the device token only as a KEY */
  const raw = await Bun.file(FILE).text();
  check("the document exists on disk", raw.length > 0);
  check(
    "the document does NOT store the device token itself",
    !raw.includes(TOKEN_GRINDER) && !raw.includes(TOKEN_SOLO),
  );
  check(
    "the document stores the token's one-way KEY instead (both identities)",
    raw.includes(playerKey(TOKEN_GRINDER)) && raw.includes(playerKey(TOKEN_SOLO)),
  );
  check("the document stores no caller key", !raw.includes("check-ace") && !raw.includes("check-brick"));
  check(
    "the document stores the fields the schema stores",
    ["name", "wins", "losses", "undefeated", "overall", "lineup", "createdAt", "seasons", "ratingSum", "perfectSeasons"].every(
      (key) => raw.includes(`"${key}"`),
    ),
  );

  /* 6. no device token and no caller hash in any API-shaped response */
  const boards = JSON.stringify({ board, players, solo, soloBoard });
  check("no device token appears in a board response", !boards.includes(TOKEN_GRINDER) && !boards.includes(TOKEN_SOLO));
  check("no 'deviceToken' key appears in a board response", !boards.includes("deviceToken"));

  /* 7. reload: a fresh process reads the same board back */
  const reloadExit = runChild("reload", DIR);
  check("a fresh server process reads the same seven runs back", reloadExit === 0);
  };

const reload = async (): Promise<void> => {
  const board = await readBoard();
  check("reload: seven runs still stored", board.total === 7, board.total);
  check("reload: still connected", board.connected === true);
  const players = await readPlayersBoard(TOKEN_GRINDER);
  check("reload: the identity's rating is still there", (players.you?.seasons ?? 0) === 4, players.you);
  const raw = await Bun.file(FILE).text();
  check("reload: no caller key in the document", !raw.includes("check-"));
};

const rateLimit = async (): Promise<void> => {
  const caller = "flood-caller";
  const outcomes: string[] = [];
  for (let attempt = 1; attempt <= 9; attempt++) {
    const outcome = await submitRun(body(`Flood${attempt}`, 5, STRONG), caller);
    outcomes.push(outcome.ok ? "ok" : outcome.error);
  }
  check("the first 8 runs from one caller are stored", outcomes.slice(0, 8).every((value) => value === "ok"), outcomes);
  check("the 9th is rate limited", outcomes[8] === "rate_limited", outcomes);
  const board = await readBoard();
  check("only the 8 accepted runs reached the board", board.total === 8, board.total);
};

const corrupt = async (): Promise<void> => {
  await post("a first run", body("Anchor", 10, STRONG), "corrupt-1");
  await writeFile(FILE, '{"version":1,"nextId":2,"runs":[{"id":1,"name":"Trunc');
  const truncated = await readBoard();
  check("a truncated document reads as an empty board", truncated.connected === true && truncated.entries.length === 0, truncated);
  await writeFile(FILE, "not json at all");
  const garbage = await readBoard();
  check("a garbage document reads as an empty board, no error", garbage.connected === true && garbage.total === 0);
  const players = await readPlayersBoard(TOKEN_GRINDER);
  check("the players board survives the same garbage", players.connected === true && players.entries.length === 0);
  await writeFile(FILE, "");
  const empty = await readBoard();
  check("an empty document reads as an empty board", empty.connected === true && empty.total === 0);
  await rm(FILE);
  const missing = await readBoard();
  check("a missing document reads as an empty board", missing.connected === true && missing.total === 0);
  const healed = await submitRun(body("Healed", 11, STRONG), "corrupt-2");
  check("and the next write repairs the store", healed.ok === true);
  const after = await readBoard();
  check("the repaired board has exactly the new run", after.total === 1 && after.entries[0]?.name === "Healed", after.total);
};

/**
 * Block every candidate directory by putting a FILE where the directory goes —
 * the one thing that makes a path unusable even for root, which is why this is
 * how "unwritable" is simulated here. A directory that already holds real board
 * data is never damaged: that candidate is reported as unblockable instead.
 */
const unwritable = async (): Promise<void> => {
  /** Our own scratch path — safe to clear. */
  const scratch = join(tmpdir(), "gridiron-immortals");
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  const targets = [scratch, join(process.cwd(), ".data"), "/home/team/.data/gridiron-immortals"];
  process.env.GRIDIRON_DATA_DIR = "/etc/hostname/board";
  const made: string[] = [];
  const unblockable: string[] = [];
  try {
    for (const target of targets) {
      const existing = await stat(target).catch(() => null);
      if (existing?.isFile()) {
        made.push(target);
        continue;
      }
      if (existing) {
        unblockable.push(target);
        continue;
      }
      await writeFile(target, "this file blocks the directory\n");
      made.push(target);
    }
    if (unblockable.length > 0) {
      console.log(`  SKIP  cannot block a candidate that holds real data: ${unblockable.join(", ")}`);
      return;
    }
    const started = Date.now();
    const board = await readBoard();
    check("an unwritable store reports connected:false", board.connected === false && board.entries.length === 0, board);
    const players = await readPlayersBoard(TOKEN_GRINDER);
    check("the players board reports connected:false", players.connected === false);
    const outcome = await submitRun(body("Nowhere", 9, STRONG), "unwritable-1");
    check(
      "a run posts as the honest not_connected, not a crash",
      outcome.ok === false && outcome.error === "not_connected",
      outcome,
    );
    check("and it fails fast (no hang)", Date.now() - started < 5_000, Date.now() - started);
  } finally {
    for (const blocker of made) await unlink(blocker).catch(() => undefined);
  }
  const left = await Promise.all(made.map(async (path) => (await stat(path).catch(() => null)) === null));
  check("the blocking files were cleaned up", left.every(Boolean), made);
};

const precedence = async (): Promise<void> => {
  /* a file-backed board with one run on it */
  await post("a file-store run", body("FileOnly", 13, STRONG), "prec-1");
  const fileBoard = await readBoard();
  check("file store holds the run while no connection string is set", fileBoard.total === 1);
  const beforeRaw = await Bun.file(FILE).text();

  /* now a well-formed but unreachable connection string. THE RULE SHIPPED ON
     2026-10-04: a string that cannot produce a connection must NOT take the
     boards down — the file store answers instead (src/server/store-choice.ts).
     The live runtime really did carry the truncated value `postgresql://`, and
     under the old rule both boards went dark while the file store sat there
     writable and working. */
  process.env.POSTGRES_URL = "postgres://postgres:gridiron@127.0.0.1:5433/gridiron_absent?sslmode=disable";
  const started = Date.now();
  const board = await readBoard();
  const elapsed = Date.now() - started;
  check(
    "an unreachable connection string does NOT report the board as not connected",
    board.connected === true,
    board.connected,
  );
  check(
    "the file store answers with its own rows",
    board.total === 1 && board.entries[0]?.name === "FileOnly",
    board.entries.map((entry) => entry.name),
  );
  check("the Postgres attempt really happened (not an instant file read)", elapsed >= 3, elapsed);
  const outcome = await submitRun(body("FallbackRun", 13, STRONG), "prec-2");
  check("a write with an unreachable connection string is stored, not refused", outcome.ok === true, outcome);
  const afterRaw = await Bun.file(FILE).text();
  check(
    "and it landed in the file document (the store grew by exactly that run)",
    afterRaw !== beforeRaw &&
      (JSON.parse(afterRaw) as { runs: unknown[] }).runs.length === 2 &&
      afterRaw.includes("FallbackRun"),
    afterRaw === beforeRaw ? "document unchanged" : "document changed",
  );
  check("describeDb still names the unresolvable string's host", describeDb().includes("127.0.0.1"), describeDb());

  /* the other half of the rule, in a FRESH process: a reachable Postgres wins
     outright over a file store that already holds rows. It has to be a child
     process — a failed connection is remembered as a 60s cooldown
     (POSTGRES_RETRY_MS), so the same process cannot observe the recovery. */
  const dbExit = runChild("precedence-db", DIR);
  check("a reachable Postgres still wins over a populated file store", dbExit === 0);
};

/**
 * The positive case of the precedence rule, run as its own process so no
 * cooldown from a previous failure is in play. Needs a real Postgres on
 * 127.0.0.1:5432 (database `gridiron_precedence`); without one this mode's
 * checks fail loudly rather than pretending to pass.
 */
const precedenceDb = async (): Promise<void> => {
  const beforeRaw = await Bun.file(FILE).text();
  check(
    "precedence-db: the file store really does hold rows before the database is used",
    beforeRaw.includes("FileOnly") && beforeRaw.includes("FallbackRun"),
  );
  process.env.POSTGRES_URL = "postgres://postgres:gridiron@127.0.0.1:5432/gridiron_precedence?sslmode=disable";
  const live = await readBoard();
  check(
    "precedence-db: a reachable Postgres answers instead of the file, from its own empty tables",
    live.connected === true && live.entries.length === 0,
    live.connected ? live.entries.length : live,
  );
  check("precedence-db: the file store is untouched on the Postgres path", (await Bun.file(FILE).text()) === beforeRaw);
};

/* --------------------------------------------------------------------- run */

/* ------------------------------------------------- the deploy tree (seeding) */
/**
 * The DEPLOY-TREE case, which is the one that decides whether a board survives
 * a publish. Run as a child process whose WORKING DIRECTORY is a fixture that
 * looks like a deployment (package.json + .data), with no GRIDIRON_DATA_DIR:
 *
 *   deploy        creates the fixture — an EMPTY `.data` (what a first deploy, or
 *                 a tree without the document, looks like) plus a valid board
 *                 sitting in the last candidate directory (TMPDIR) — then runs
 *                 the child in it and checks what landed in the deploy tree.
 *   deploy-child  runs inside that fixture: the store must resolve to
 *                 `<cwd>/.data/board.json`, must ADOPT the document it finds
 *                 elsewhere instead of starting an empty board, and must write
 *                 new seasons into the deploy tree (where they ship).
 *
 * Neither mode touches a real directory: GRIDIRON_PLATFORM_DATA_DIR points the
 * platform fallback at a path that does not exist.
 */
const DEPLOY_ROOT = process.env.CHECK_DEPLOY_ROOT ?? join(tmpdir(), `gridiron-deploy-${process.pid}`);
const DEPLOY_FILE = join(DEPLOY_ROOT, ".data", "board.json");
const DEPLOY_TMP = join(DEPLOY_ROOT, "tmp");
const SEED_FILE = join(DEPLOY_TMP, "gridiron-immortals", "board.json");

/** A small, valid document to seed from: two runs, one rated identity. */
const seededDoc = (): Record<string, unknown> => ({
  version: 1,
  nextId: 3,
  runs: [
    {
      id: 1,
      name: "Seeded-A",
      wins: 17,
      losses: 0,
      undefeated: true,
      overall: 96.4,
      lineup: STRONG,
      createdAt: "2026-10-03T00:00:00.000Z",
    },
    {
      id: 2,
      name: "Seeded-B",
      wins: 11,
      losses: 6,
      undefeated: false,
      overall: 88.1,
      lineup: WEAK,
      createdAt: "2026-10-03T01:00:00.000Z",
    },
  ],
  players: [
    {
      deviceToken: playerKey(TOKEN_SOLO),
      name: "Seeded-A",
      seasons: 4,
      ratingSum: 4200,
      rating: 1050,
      wins: 51,
      losses: 17,
      bestWins: 17,
      bestLosses: 0,
      bestOverall: 96.4,
      perfectSeasons: 1,
      createdAt: "2026-10-03T00:00:00.000Z",
      updatedAt: "2026-10-03T01:00:00.000Z",
    },
  ],
});

const deploy = async (): Promise<void> => {
  await rm(DEPLOY_ROOT, { recursive: true, force: true });
  await mkdir(join(DEPLOY_ROOT, ".data"), { recursive: true });
  await mkdir(join(DEPLOY_TMP, "gridiron-immortals"), { recursive: true });
  await writeFile(join(DEPLOY_ROOT, "package.json"), JSON.stringify({ name: "gridiron-deploy-fixture" }));
  await writeFile(SEED_FILE, JSON.stringify(seededDoc()));
  const env: Record<string, string | undefined> = {
    ...process.env,
    CHECK_DEPLOY_ROOT: DEPLOY_ROOT,
    CHECK_DIR: join(DEPLOY_ROOT, "check"),
    TMPDIR: DEPLOY_TMP,
    GRIDIRON_PLATFORM_DATA_DIR: join(DEPLOY_ROOT, "no-such-platform-dir"),
  };
  delete env.GRIDIRON_DATA_DIR;
  delete env.DATA_DIR;
  delete env.DATABASE_URL;
  delete env.NEON_DATABASE_URL;
  delete env.POSTGRES_URL;
  const child = Bun.spawnSync({
    cmd: [process.execPath, import.meta.path, "--mode=deploy-child"],
    cwd: DEPLOY_ROOT,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  check("deploy: the child process running in a deploy tree passed", (child.exitCode ?? 1) === 0);
  const raw = await Bun.file(DEPLOY_FILE).text();
  const after = JSON.parse(raw) as { runs: { name: string }[]; players: unknown[] };
  check(
    "deploy: the board document is written INSIDE the deploy tree (the file a publish ships)",
    after.runs.length === 3,
    after.runs.map((run) => run.name),
  );
  check(
    "deploy: the adopted seasons and the new one are all there",
    ["Seeded-A", "Seeded-B", "FreshRun"].every((name) => after.runs.some((run) => run.name === name)),
  );
  check("deploy: the adopted rating row is in the shipped document", after.players.length === 2, after.players.length);
  check("deploy: no device token in the shipped document, only its key", !raw.includes(TOKEN_SOLO));

  // Pass 2: a READS-BACK document is the base state even when it holds nothing.
  // A publish that ships a deliberately empty board must not be "repaired" from
  // whatever happens to sit in a fallback directory.
  await writeFile(DEPLOY_FILE, JSON.stringify({ version: 1, nextId: 1, runs: [], players: [] }));
  const child2 = Bun.spawnSync({
    cmd: [process.execPath, import.meta.path, "--mode=deploy-child-empty"],
    cwd: DEPLOY_ROOT,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  check("deploy: a readable EMPTY document is not seeded over", (child2.exitCode ?? 1) === 0);
  const afterEmptyText = await Bun.file(DEPLOY_FILE).text();
  check(
    "deploy: the deliberately empty base state adopted nothing from elsewhere",
    !afterEmptyText.includes("Seeded-"),
    afterEmptyText.slice(0, 200),
  );

  // Pass 3: NOTHING writable anywhere. The deploy tree's `.data` is replaced by a
  // FILE (so the directory cannot be made), the platform fallback points under a
  // path that is itself a file, and TMPDIR is unusable too. This is the one state
  // that must stay an honest "not connected" instead of a crash or a 500.
  await rm(join(DEPLOY_ROOT, ".data"), { recursive: true, force: true });
  await writeFile(join(DEPLOY_ROOT, ".data"), "not a directory\n");
  const lockedEnv: Record<string, string | undefined> = {
    ...env,
    TMPDIR: "/etc/hostname/locked",
    GRIDIRON_PLATFORM_DATA_DIR: "/etc/hostname/locked/platform",
  };
  const child3 = Bun.spawnSync({
    cmd: [process.execPath, import.meta.path, "--mode=deploy-locked-child"],
    cwd: DEPLOY_ROOT,
    env: lockedEnv,
    stdout: "inherit",
    stderr: "inherit",
  });
  check("deploy: with nowhere writable the store still answers honestly", (child3.exitCode ?? 1) === 0);
  await rm(DEPLOY_ROOT, { recursive: true, force: true });
};

const deployLockedChild = async (): Promise<void> => {
  const store = await describeStore();
  check("deploy-locked-child: no directory could be resolved", store.kind === "none", store);
  const board = await readBoard();
  check("deploy-locked-child: the run board says 'not connected' rather than throwing", board.connected === false && board.total === 0, board);
  const players = await readPlayersBoard(TOKEN_GRINDER);
  check("deploy-locked-child: the players board says the same", players.connected === false, players.connected);
  const outcome = await submitRun(body("Nowhere", 10, STRONG, TOKEN_GRINDER), "deploy-locked-child-locked");
  check(
    "deploy-locked-child: a submission is refused with 'not_connected', not an exception",
    outcome.ok === false && outcome.error === "not_connected",
    outcome,
  );
};

const deployChildEmpty = async (): Promise<void> => {
  const board = await readBoard();
  check("deploy-child-empty: an empty shipped document reads as an empty board", board.total === 0, board.total);
  check(
    "deploy-child-empty: and the board is NOT seeded from another directory",
    (await stat(DEPLOY_FILE)).size === 0 || !(await Bun.file(DEPLOY_FILE).text()).includes("Seeded-A"),
  );
  const outcome = await submitRun(body("EmptyBaseRun", 10, STRONG, TOKEN_GRINDER), "deploy-child-empty");
  check("deploy-child-empty: a new season still stores into the empty base", outcome.ok === true, outcome);
  const after = JSON.parse(await Bun.file(DEPLOY_FILE).text()) as { runs: { name: string }[] };
  check(
    "deploy-child-empty: the document holds that one season and no adopted ones",
    after.runs.length === 1 && after.runs[0]?.name === "EmptyBaseRun",
    after.runs.map((run) => run.name),
  );
};

const deployChild = async (): Promise<void> => {
  const store = await describeStore();
  check("deploy-child: no GRIDIRON_DATA_DIR override is in play", (process.env.GRIDIRON_DATA_DIR ?? "") === "");
  check("deploy-child: the store resolves to <deploy root>/.data/board.json", store.file === DEPLOY_FILE, store);
  check("deploy-child: and names that directory as the shipped one", store.source === "deploy", store.source);
  const board = await readBoard();
  check(
    "deploy-child: an empty deploy tree ADOPTS the board instead of starting empty",
    board.total === 2 && board.entries.some((entry) => entry.name === "Seeded-A"),
    board.total,
  );
  check("deploy-child: the adopted document is now written into the deploy tree", (await stat(DEPLOY_FILE)).isFile());
  const players = await readPlayersBoard(TOKEN_SOLO);
  check("deploy-child: an adopted rating row still credits its own device", players.you?.seasons === 4, players.you);
  const outcome = await submitRun(body("FreshRun", 13, STRONG, TOKEN_GRINDER), "deploy-child");
  check("deploy-child: a season can be stored in the deploy tree", outcome.ok === true, outcome);
  const raw = await Bun.file(DEPLOY_FILE).text();
  check(
    "deploy-child: the token is stored as its KEY, never as the token",
    !raw.includes(TOKEN_GRINDER) && raw.includes(playerKey(TOKEN_GRINDER)),
  );
  const after = JSON.parse(raw) as { runs: unknown[]; players: unknown[] };
  check(
    "deploy-child: the document grew to three seasons and two identities",
    after.runs.length === 3 && after.players.length === 2,
  );
};

if (mode === "main") await main();
else if (mode === "reload") await reload();
else if (mode === "rate-limit") await rateLimit();
else if (mode === "corrupt") await corrupt();
else if (mode === "unwritable") await unwritable();
else if (mode === "precedence") await precedence();
else if (mode === "precedence-db") await precedenceDb();
else if (mode === "deploy") await deploy();
else if (mode === "deploy-child") await deployChild();
else if (mode === "deploy-child-empty") await deployChildEmpty();
else if (mode === "deploy-locked-child") await deployLockedChild();
else throw new Error(`unknown mode ${mode}`);

if (mode !== "reload") await rm(DIR, { recursive: true, force: true });
// Only the parent clears the fixture: the child must leave the deploy tree in
// place for the parent to inspect what it wrote there.
if (mode === "deploy") await rm(DEPLOY_ROOT, { recursive: true, force: true });

console.log(`\n${mode}: ${String(checks - failures)}/${String(checks)} checks passed`);
if (failures > 0) process.exit(1);
