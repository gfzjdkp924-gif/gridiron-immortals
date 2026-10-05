/**
 * Gridiron Immortals — the anonymous finished-season counters, checked for real.
 *
 *   bun tools/run-count-check.ts              # --mode=main
 *   bun tools/run-count-check.ts --mode=degraded
 *   bun tools/run-count-check.ts --mode=prune
 *
 * What it proves, in the order the requirements were written:
 *
 *   main      a fresh store counts 1 for a first finished season and 1 for a
 *             following one, the byDay tally tracks the UTC day, the numbers
 *             round-trip through the file, the stored block holds EXACTLY the
 *             five expected keys (nothing about a device, a name or a caller),
 *             and the request-shape check refuses everything that is not one
 *             boolean under one key.
 *   degraded  the counters survive a corrupt document (salvaged), a file that
 *             cannot be read, and a file that has been DELETED — a degraded read
 *             can never write zeros over real numbers (the process high-water
 *             mark in src/server/file-store.ts).
 *   prune     a document carrying 40 days of tallies comes back holding the last
 *             30, with the totals never below what the days add up to.
 *
 * It never touches the deployment's own document: every mode points
 * GRIDIRON_DATA_DIR at a fresh temporary directory and deletes it afterwards.
 * The counters live INSIDE the board document, so the checks read and write the
 * real store through the real modules — src/server/run-stats.ts for the API and
 * src/lib/run-stats.ts for the rules — never a reimplementation of them.
 */
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_COUNT_BODY_BYTES,
  countBody,
  mergeRunStats,
  parseCountBody,
  utcDayKey,
} from "~/lib/run-stats";
import { readRunStats, recordFinishedRun } from "~/server/run-stats";

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
const DIR = process.env.CHECK_DIR ?? join(tmpdir(), `gridiron-run-count-${mode}-${process.pid}`);
process.env.GRIDIRON_DATA_DIR = DIR;
delete process.env.DATABASE_URL;
delete process.env.NEON_DATABASE_URL;
delete process.env.POSTGRES_URL;

const FILE = join(DIR, "board.json");

const rawDoc = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await Bun.file(FILE).text()) as Record<string, unknown>;

const writeDoc = async (doc: unknown): Promise<void> => {
  await mkdir(DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(doc));
};

/* -------------------------------------------------------------------- modes */

const main = async (): Promise<void> => {
  console.log(`run counters at ${FILE}\n`);

  /* 1. a store nobody has counted in yet */
  const before = await readRunStats();
  check("a fresh store reads connected with zero counters", before.connected === true, before);
  check(
    "and nothing has been counted yet",
    before.counters.runsFinished === 0 && before.counters.firstRuns === 0 && before.counters.updatedAt === null,
    before.counters,
  );

  /* 2. the first finished season on the device, then two more */
  const today = utcDayKey(new Date());
  const first = await recordFinishedRun(true);
  check("a first finished season counts one run and one first", first?.runsFinished === 1 && first?.firstRuns === 1, first);
  check("it lands on today's UTC day", first?.byDay[today] === 1 && first?.firstByDay[today] === 1, first?.byDay);
  check("and it stamps when it moved", typeof first?.updatedAt === "string", first?.updatedAt);

  const second = await recordFinishedRun(false);
  check("a later season on the same device counts only the total", second?.runsFinished === 2 && second?.firstRuns === 1, second);
  const third = await recordFinishedRun(false);
  check("and so does the next one", third?.runsFinished === 3 && third?.firstRuns === 1, third);
  check("the day tally is three", third?.byDay[today] === 3, third?.byDay);
  check("the first-run day tally is still one", third?.firstByDay[today] === 1, third?.firstByDay);

  /* 3. the numbers survive being read back off the disk */
  const read = await readRunStats();
  check("the counters read back from the document", read.counters.runsFinished === 3 && read.counters.firstRuns === 1, read.counters);

  /* 4. THE SHAPE: exactly the five keys, and nothing that identifies anyone */
  const doc = await rawDoc();
  const stats = doc.stats as Record<string, unknown>;
  check(
    "the stored block holds exactly the five expected keys",
    JSON.stringify(Object.keys(stats).sort()) ===
      JSON.stringify(["byDay", "firstByDay", "firstRuns", "runsFinished", "updatedAt"]),
    Object.keys(stats),
  );
  check(
    "and the stored block holds no token, name, address or identifier of any kind",
    !/token|device|name|email|ip|ipaddr|useragent|user_agent|cookie|session|id\b/i.test(JSON.stringify(stats)),
    stats,
  );
  const board = await rawDoc();
  check(
    "the counters live inside the board document (so a publish carries them)",
    Array.isArray(board.runs) && Array.isArray(board.players) && typeof board.stats === "object",
    Object.keys(board),
  );
  check("the document is written with stats near the front", Object.keys(board)[1] === "stats", Object.keys(board));

  /* 5. the request shape check: one boolean under one key, or nothing */
  check("`{first:true}` counts as a first run", parseCountBody(countBody(true)) === true);
  check("`{first:false}` counts as a later run", parseCountBody(countBody(false)) === false);
  check("an object with a second key is refused", parseCountBody('{"first":true,"device":"abc"}') === null);
  check("a non-boolean is refused", parseCountBody('{"first":"true"}') === null && parseCountBody('{"first":1}') === null);
  check("a renamed key is refused", parseCountBody('{"firstRun":true}') === null);
  check("an array, a bare value and empty input are refused", [
    parseCountBody("[true]"),
    parseCountBody("true"),
    parseCountBody(""),
  ].every((value) => value === null));
  check("malformed JSON is refused", parseCountBody("{first:true}") === null);
  check(
    "an oversized body is refused before it is parsed",
    parseCountBody(`{"first":true,"pad":"${"x".repeat(MAX_COUNT_BODY_BYTES)}"}`) === null,
  );

  /* 6. the merge rule the sync and the high-water mark both use */
  const merged = mergeRunStats(
    { runsFinished: 5, firstRuns: 2, byDay: { "2026-10-01": 5 }, firstByDay: { "2026-10-01": 2 }, updatedAt: null },
    { runsFinished: 0, firstRuns: 0, byDay: {}, firstByDay: {}, updatedAt: null },
  );
  check("merging with a zeroed reading keeps the larger one", merged.runsFinished === 5 && merged.firstRuns === 2, merged);
  const grown = mergeRunStats(merged, {
    runsFinished: 9,
    firstRuns: 3,
    byDay: { "2026-10-02": 4 },
    firstByDay: { "2026-10-02": 1 },
    updatedAt: "2026-10-02T00:00:00.000Z",
  });
  check(
    "and a genuinely larger reading wins, day by day",
    grown.runsFinished === 9 && grown.firstRuns === 3 && grown.byDay["2026-10-01"] === 5 && grown.byDay["2026-10-02"] === 4,
    grown,
  );
};

const degraded = async (): Promise<void> => {
  /* a real board document with counters on it */
  await writeDoc({
    version: 1,
    stats: {
      runsFinished: 6,
      firstRuns: 2,
      byDay: { "2026-10-03": 6 },
      firstByDay: { "2026-10-03": 2 },
      updatedAt: "2026-10-03T12:00:00.000Z",
    },
    nextId: 1,
    runs: [],
    players: [],
  });
  const started = await readRunStats();
  check("the fixture reads six finished seasons", started.counters.runsFinished === 6, started.counters);

  /* 1. a TRUNCATED document: the counters in it are still readable */
  await writeFile(FILE, '{"version":1,"stats":{"runsFinished":6,"firstRuns":2,"byDay":{"2026-10-03":6},"firstByDay":{"2026-10-03":2},"updatedAt":"2026-10-03T12:00:00.000Z"},"runs":[{"id":1,"na');
  const salvaged = await readRunStats();
  check("a truncated document still reports the counters it held", salvaged.counters.runsFinished === 6, salvaged.counters);
  check("with its first-run count intact", salvaged.counters.firstRuns === 2, salvaged.counters);

  /* 2. the write that follows a degraded read does NOT zero them */
  const afterCorrupt = await recordFinishedRun(false);
  check(
    "a season counted right after a corrupt read does not zero the counters",
    afterCorrupt?.runsFinished === 7 && afterCorrupt?.firstRuns === 2,
    afterCorrupt,
  );

  /* 3. garbage, then an empty file, then a DELETED file — same rule each time */
  await writeFile(FILE, "not json at all");
  const garbage = await recordFinishedRun(true);
  check(
    "garbage on disk does not zero them either",
    (garbage?.runsFinished ?? 0) >= 8 && (garbage?.firstRuns ?? 0) >= 3,
    garbage,
  );
  await writeFile(FILE, "");
  const emptied = await readRunStats();
  check(
    "an empty file reads as connected with the counters still standing",
    emptied.connected === true && emptied.counters.runsFinished >= 8,
    emptied.counters,
  );
  await unlink(FILE);
  const missing = await readRunStats();
  check("a deleted file reads as an empty board, not an error", missing.connected === true, missing);
  const afterMissing = await recordFinishedRun(false);
  check(
    "and the next count still carries the numbers this process had already seen",
    (afterMissing?.runsFinished ?? 0) >= 9,
    afterMissing,
  );
  const persisted = await rawDoc();
  check("the file now on disk holds those counters", (persisted.stats as { runsFinished: number }).runsFinished >= 9, persisted.stats);
};

const prune = async (): Promise<void> => {
  const byDay: Record<string, number> = {};
  const firstByDay: Record<string, number> = {};
  for (let day = 1; day <= 40; day += 1) {
    const key = `2026-08-${String(day).padStart(2, "0")}`;
    byDay[key] = day;
    firstByDay[key] = 1;
  }
  await writeDoc({
    version: 1,
    stats: { runsFinished: 100_000, firstRuns: 40, byDay, firstByDay, updatedAt: "2026-08-40T00:00:00.000Z" },
    nextId: 1,
    runs: [],
    players: [],
  });
  const read = await readRunStats();
  check("only the last 30 days are kept", Object.keys(read.counters.byDay).length === 30, Object.keys(read.counters.byDay).length);
  check("the oldest days are the ones dropped", read.counters.byDay["2026-08-01"] === undefined && read.counters.byDay["2026-08-11"] === 11, read.counters.byDay);
  check("a nonsense updatedAt is dropped rather than kept", read.counters.updatedAt === null, read.counters.updatedAt);
  const counted = await recordFinishedRun(true);
  check("counting once more on top of a pruned document adds one", counted?.runsFinished === 100_001, counted);

  /* a hostile document: counters that are not numbers at all */
  await writeDoc({
    version: 1,
    stats: { runsFinished: "lots", firstRuns: -4, byDay: { "not-a-day": 9, "2026-10-04": "3" }, firstByDay: null, updatedAt: 5 },
    nextId: 1,
    runs: [],
    players: [],
  });
  const hostile = await readRunStats();
  check(
    "nonsense counters are repaired into numbers, never thrown on",
    hostile.connected === true && hostile.counters.runsFinished === 3 && hostile.counters.firstRuns === 0,
    hostile.counters,
  );
  check("and only real day keys survive", Object.keys(hostile.counters.byDay).join() === "2026-10-04", hostile.counters.byDay);
};

/* -------------------------------------------------------------------- entry */

const modes: Record<string, () => Promise<void>> = { main, degraded, prune };
const run = modes[mode];
if (!run) {
  console.error(`unknown --mode=${mode} (try main, degraded, prune)`);
  process.exit(1);
}

try {
  await run();
  console.log(`\n${checks - failures}/${checks} checks passed (mode=${mode})`);
  if (failures > 0) process.exit(1);
} finally {
  await rm(DIR, { recursive: true, force: true }).catch(() => undefined);
}
