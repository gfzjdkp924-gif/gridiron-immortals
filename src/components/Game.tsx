import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Player } from "~/data/players";
import Paywall from "~/components/Paywall";
import { ShareResult } from "~/components/ShareResult";
import SiteFooter from "~/components/SiteFooter";
import SubmitLocked from "~/components/SubmitLocked";
import SubmitRun from "~/components/SubmitRun";
import { StatLine } from "~/components/StatLine";
import { hasFinishedARun, isUnlocked, markFreeRunUsed, useEntitlement } from "~/lib/entitlement";
import { STORE_BUILD } from "~/lib/build-flags";
import { countFinishedRun, isFirstFinishedRun } from "~/lib/run-count";
import { GAME_FOOTER, HOME_PRICE_NOTE, HOME_RATING_NOTE } from "~/lib/paywall";
import {
  GROUPS,
  ROSTER_SLOTS,
  SEASON_GAMES,
  TOTAL_SLOTS,
  draftPlayer,
  eligibleInGroup,
  emptySlots,
  groupsWithEligible,
  newSeed,
  rateRoster,
  randomGroup,
  simulateSeason,
  type DraftedPlayer,
  type Group,
  type SeasonResult,
} from "~/lib/game";
import { bestRun, clearRuns, loadRuns, newRunId, saveRun, type StoredRun } from "~/lib/storage";

type Phase = "home" | "board" | "season" | "result";

const REEL_ITEM_PX = 76;
const SPIN_MS = 1500;

const shuffle = <T,>(items: T[]): T[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
};

const lastName = (name: string): string => {
  const parts = name.replace(/[.]/g, "").split(" ");
  return parts.length === 1 ? name : (parts[parts.length - 1] ?? name);
};

const formatDate = (ts: number): string =>
  new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export default function Game() {
  const [phase, setPhase] = useState<Phase>("home");
  const [roster, setRoster] = useState<DraftedPlayer[]>([]);
  const [spin, setSpin] = useState<Group | null>(null);
  const [reelLabels, setReelLabels] = useState<string[]>([]);
  const [reelIndex, setReelIndex] = useState(0);
  const [reelSpin, setReelSpin] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const [rerollMsg, setRerollMsg] = useState<string | null>(null);
  const [stuck, setStuck] = useState(false);
  const [season, setSeason] = useState<SeasonResult | null>(null);
  const [revealed, setRevealed] = useState(0);
  const [runs, setRuns] = useState<StoredRun[]>([]);
  const [savedId, setSavedId] = useState<string | null>(null);
  // True once a start has been refused: the paywall renders *below* whatever is
  // already on screen, so a finished result is never yanked away.
  const [locked, setLocked] = useState(false);

  const entitlement = useEntitlement();

  const rosterRef = useRef<DraftedPlayer[]>([]);
  const seedRef = useRef<number>(newSeed());
  const timers = useRef<number[]>([]);
  const savedRef = useRef(false);

  const later = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(fn, ms);
    timers.current.push(id);
  }, []);

  const clearTimers = useCallback(() => {
    for (const id of timers.current) window.clearTimeout(id);
    timers.current = [];
  }, []);

  const setRosterBoth = useCallback((next: DraftedPlayer[]) => {
    rosterRef.current = next;
    setRoster(next);
  }, []);

  // History lives on the device; read it after mount so SSR renders the same markup.
  useEffect(() => {
    setRuns(loadRuns());
    return clearTimers;
  }, [clearTimers]);

  const best = useMemo(() => bestRun(runs), [runs]);
  const savedRun = useMemo(
    () => (savedId === null ? null : (runs.find((r) => r.id === savedId) ?? null)),
    [runs, savedId],
  );
  const ratings = useMemo(() => rateRoster(roster), [roster]);
  const picks = roster.length;

  /* ------------------------------------------------------------- spinning */

  const rollTo = useCallback(
    (labels: string[], ms: number, done: () => void) => {
      setReelLabels(labels);
      setReelIndex(0);
      setReelSpin(false);
      later(() => {
        setReelSpin(true);
        setReelIndex(labels.length - 1);
      }, 40);
      later(done, ms + 60);
    },
    [later],
  );

  const finishSpin = useCallback(
    (group: Group, attempt: number) => {
      setSpinning(false);
      if (eligibleInGroup(group, rosterRef.current).length > 0) {
        setRerollMsg(null);
        return;
      }
      // Nothing at this team + era fills an open slot: the manager never stalls.
      const fallback = groupsWithEligible(rosterRef.current);
      setRerollMsg(`${group.label} has nothing left for your open slots — re-spinning…`);

      if (attempt >= 12) {
        const forced = fallback[Math.floor(Math.random() * fallback.length)];
        if (!forced) {
          // Cannot happen with this pool; never freeze the player on a spinner.
          setRerollMsg("No eligible players left on the board.");
          setStuck(true);
          return;
        }
        setSpin(forced);
        const preview = shuffle(GROUPS.map((g) => g.label)).slice(0, 5);
        setSpinning(true);
        rollTo([...preview, forced.label], 700, () => setSpinning(false));
        return;
      }
      later(() => startSpinRef.current(attempt + 1), 650);
    },
    [later, rollTo],
  );

  const startSpin = useCallback(
    (attempt = 0) => {
      clearTimers();
      setStuck(false);
      const group = randomGroup();
      const preview = shuffle(GROUPS.map((g) => g.label)).slice(0, 11);
      setRerollMsg(null);
      setSpin(group);
      setSpinning(true);
      rollTo([...preview, group.label], SPIN_MS, () => finishSpin(group, attempt));
    },
    [clearTimers, finishSpin, rollTo],
  );

  const startSpinRef = useRef(startSpin);
  startSpinRef.current = startSpin;

  /**
   * The only writer of `phase === "board"`, and the only place a run starts, so
   * it is the only place the gate needs to live. Three callers reach it: the
   * home spin button, the stuck-roster restart, and "Run it back" on the result
   * screen.
   *
   * The check reads storage synchronously rather than React state on purpose —
   * a click is a decision, and it must see what is on the device right now. The
   * free run is written when a season FINISHES, so a device that has never
   * finished one always gets through, and nothing can burn the allowance by
   * being reloaded mid-draft.
   *
   * THE STORE BUILD HAS NO GATE AT ALL. `STORE_BUILD` is the literal `true`
   * there, so the condition below is folded away by the build and a paid
   * download — a fresh one included — starts a run the moment it is tapped, and
   * can run it back as often as it likes. In the web build this is exactly the
   * check it has always been: `isUnlocked()` and `hasFinishedARun()` are
   * unchanged when the flag is off.
   */
  const startRun = useCallback(() => {
    if (!STORE_BUILD && !isUnlocked() && hasFinishedARun()) {
      setLocked(true);
      return;
    }
    setLocked(false);
    clearTimers();
    savedRef.current = false;
    seedRef.current = newSeed();
    setRosterBoth([]);
    setSeason(null);
    setRevealed(0);
    setSavedId(null);
    setPhase("board");
    startSpin(0);
  }, [clearTimers, setRosterBoth, startSpin]);

  const pick = useCallback(
    (player: Player) => {
      const next = draftPlayer(rosterRef.current, player);
      setRosterBoth(next);
      if (next.length >= TOTAL_SLOTS) {
        clearTimers();
        setSpinning(false);
        setSpin(null);
        setRerollMsg(null);
        setPhase("season");
        return;
      }
      startSpin(0);
    },
    [clearTimers, setRosterBoth, startSpin],
  );

  /* -------------------------------------------------------------- season */

  const playSeason = useCallback(() => {
    setRevealed(0);
    setSeason(simulateSeason(rosterRef.current, seedRef.current));
  }, []);

  useEffect(() => {
    if (!season || revealed >= SEASON_GAMES) return;
    const id = window.setTimeout(() => setRevealed((n) => n + 1), revealed === 0 ? 220 : 85);
    return () => window.clearTimeout(id);
  }, [season, revealed]);

  useEffect(() => {
    if (!season || revealed < SEASON_GAMES || savedRef.current) return;
    const id = window.setTimeout(() => {
      savedRef.current = true;
      // Asked BEFORE the finish is recorded, so it answers for this season:
      // "was this the first season this browser has ever finished?" — the one
      // fact the anonymous finished-season count sends (src/lib/run-count.ts).
      const firstEverRun = isFirstFinishedRun();
      // The free run is consumed here, at the finish — never at the start.
      markFreeRunUsed();
      const record: StoredRun = {
        id: newRunId(),
        finishedAt: Date.now(),
        wins: season.wins,
        losses: season.losses,
        undefeated: season.undefeated,
        overall: Math.round(season.ratings.overall * 10) / 10,
        roster: rosterRef.current,
      };
      setRuns(saveRun(record));
      setSavedId(record.id);
      setPhase("result");
      // Counted, anonymously, for the owner's one honest measure of whether
      // anyone is playing at all. AFTER the run is saved above, so a counter
      // that is unreachable, slow or broken costs the player nothing: it is
      // fired without being awaited, its failures are swallowed, it retries
      // nothing, and it changes no screen. Sent for a free run and a paid one
      // alike, and whether or not posting is switched on.
      countFinishedRun(firstEverRun);
    }, 900);
    return () => window.clearTimeout(id);
  }, [season, revealed]);

  const skipReveal = useCallback(() => setRevealed(SEASON_GAMES), []);

  /* ---------------------------------------------------------------- view */

  return (
    <div className="min-h-dvh bg-[#070c17] text-slate-100">
      <div className="mx-auto w-full max-w-md px-4 pb-10 pt-5 lg:max-w-5xl lg:px-8">
        <Header phase={phase} picks={picks} />

        {phase === "home" ? (
          <Home best={best} runs={runs} onSpin={startRun} onClear={() => {
            clearRuns();
            setRuns([]);
          }} />
        ) : null}

        {phase === "board" ? (
          <Board
            roster={roster}
            spin={spin}
            spinning={spinning}
            reelLabels={reelLabels}
            reelIndex={reelIndex}
            reelSpin={reelSpin}
            rerollMsg={rerollMsg}
            stuck={stuck}
            onPick={pick}
            onRestart={startRun}
          />
        ) : null}

        {phase === "season" && season === null ? (
          <SeasonIntro roster={roster} ratings={ratings} onPlay={playSeason} />
        ) : null}

        {phase === "season" && season !== null ? (
          <SeasonLive season={season} revealed={revealed} onSkip={skipReveal} />
        ) : null}

        {phase === "result" && season !== null ? (
          <Result
            season={season}
            roster={roster}
            best={best}
            savedId={savedId}
            savedRun={savedRun}
            unlocked={entitlement.loaded && entitlement.unlocked}
            onAgain={startRun}
            onHome={() => setPhase("home")}
          />
        ) : null}

        {/* The paywall, when it applies, goes *under* the current screen. The
            store build has no paywall: there is no gate that can set `locked`,
            and the panel — with the price and the buy link, both of which come
            from the paywall module — is not part of its bundle. */}
        {!STORE_BUILD && locked ? <Paywall /> : null}

        {/* What the game costs, then the two pages the product owes its
            players: the privacy policy and support. */}
        <footer className="mt-8 text-center text-[11px] text-slate-500">{GAME_FOOTER}</footer>
        <SiteFooter />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ chrome */

function Header({ phase, picks }: { phase: Phase; picks: number }) {
  return (
    <header className="mb-4 flex items-end justify-between gap-3">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-[#f5c451]">
          All-time draft
        </p>
        <h1 className="text-xl font-black uppercase leading-none tracking-tight sm:text-2xl">
          Gridiron <span className="text-[#f5c451]">Immortals</span>
        </h1>
      </div>
      {phase === "board" ? (
        <div className="rounded-full border border-white/15 px-3 py-1 text-right">
          <p className="font-mono text-[10px] uppercase tracking-widest text-slate-400">Picks</p>
          <p className="font-mono text-sm font-bold leading-none">
            {picks}
            <span className="text-slate-500">/{TOTAL_SLOTS}</span>
          </p>
        </div>
      ) : null}
    </header>
  );
}

/* -------------------------------------------------------------------- home */

function Home({
  best,
  runs,
  onSpin,
  onClear,
}: {
  best: StoredRun | null;
  runs: StoredRun[];
  onSpin: () => void;
  onClear: () => void;
}) {
  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-white/10 bg-gradient-to-b from-[#13203d] to-[#0d1730] p-5 lg:p-7">
        <h2 className="text-2xl font-black leading-tight sm:text-3xl lg:text-4xl">
          Spin a franchise. Draft its legends. Chase 17–0.
        </h2>
        <p className="mt-3 text-sm text-slate-300">
          Every pick starts with its own spin of a random team and decade. Draft one real player
          from each era the wheel lands on until your 11-man lineup is full, then play the season
          and see whether you run the table.
        </p>
        <ul className="mt-4 grid grid-cols-3 gap-2 text-center font-mono text-[10px] uppercase tracking-wider text-slate-400">
          <li className="rounded-lg border border-white/10 py-2">
            <span className="block text-base font-bold text-slate-100">Spin</span>team + decade
          </li>
          <li className="rounded-lg border border-white/10 py-2">
            <span className="block text-base font-bold text-slate-100">Draft</span>11 positions
          </li>
          <li className="rounded-lg border border-white/10 py-2">
            <span className="block text-base font-bold text-slate-100">Play</span>17 games
          </li>
        </ul>
        <button
          type="button"
          onClick={onSpin}
          data-testid="spin-button"
          className="mt-5 h-16 w-full rounded-2xl bg-[#f5c451] text-lg font-black uppercase tracking-[0.18em] text-[#0a1020] shadow-[0_10px_30px_-10px_rgba(245,196,81,0.8)] transition active:scale-[0.98]"
        >
          Spin the wheel
        </button>
        <div className="mt-2 flex gap-2">
          <Link
            to="/leaderboard"
            data-testid="leaderboard-link"
            className="flex h-12 flex-1 items-center justify-center rounded-2xl border border-white/15 px-2 text-center text-[11px] font-bold uppercase leading-tight tracking-widest text-slate-300 transition hover:border-[#f5c451]/60 hover:text-slate-100"
          >
            Global leaderboard
          </Link>
          <Link
            to="/players"
            data-testid="players-link"
            className="flex h-12 flex-1 items-center justify-center rounded-2xl border border-white/15 px-2 text-center text-[11px] font-bold uppercase leading-tight tracking-widest text-slate-300 transition hover:border-[#f5c451]/60 hover:text-slate-100"
          >
            Players board
          </Link>
        </div>
        {/* The player's own page: every season this device has finished, posted
            or not. One line under the boards, so it is unmissable on a phone. */}
        <Link
          to="/profile"
          data-testid="profile-link"
          className="mt-2 flex h-11 w-full items-center justify-center rounded-2xl border border-white/15 px-2 text-center text-[11px] font-bold uppercase tracking-widest text-slate-300 transition hover:border-[#f5c451]/60 hover:text-slate-100"
        >
          Your profile &amp; seasons
        </Link>
        <p className="mt-2 text-center text-[11px] text-slate-500">{HOME_RATING_NOTE}</p>
        <p className="mt-1 text-center text-[11px] text-slate-500">{HOME_PRICE_NOTE}</p>
      </section>

      <section className="rounded-2xl border border-white/10 bg-[#0d1730] p-4">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.28em] text-slate-400">
          This device
        </h3>
        {best ? (
          <div className="mt-2 flex items-center justify-between gap-3">
            <div>
              <p data-testid="best-run" className="font-mono text-3xl font-black leading-none text-[#f5c451]">
                {best.wins}–{best.losses}
              </p>
              <p className="mt-1 text-xs text-slate-400">
                Best run · {best.undefeated ? "UNDEFEATED" : "no perfect season"} · roster{" "}
                {best.overall}
              </p>
            </div>
            <div className="text-right text-xs text-slate-400">
              <p className="font-semibold text-slate-200">{topPlayer(best)?.name ?? "—"}</p>
              <p className="font-mono">
                {topPlayer(best)?.position} {topPlayer(best)?.rating}
              </p>
              <p className="mt-1">{formatDate(best.finishedAt)}</p>
            </div>
          </div>
        ) : (
          <p className="mt-2 text-sm text-slate-300">
            No runs yet. Your first spin is waiting — can this roster go undefeated?
          </p>
        )}

        {/*
          A saved run can be shared long after the result screen is gone — a
          reload, a closed tab, tomorrow. The best run on the device is the one
          worth showing someone, and `compact` keeps this to a single button.
        */}
        {best ? (
          <div className="mt-3">
            <ShareResult run={best} compact />
          </div>
        ) : null}

        {runs.length > 0 ? (
          <div className="mt-4 border-t border-white/10 pt-3">
            <h4 className="font-mono text-[10px] uppercase tracking-[0.28em] text-slate-400">
              Recent runs · {runs.length}
            </h4>
            <ul className="mt-2 divide-y divide-white/5">
              {runs.slice(0, 5).map((run) => (
                <li key={run.id} className="flex items-center justify-between gap-3 py-2 text-xs">
                  <span className="font-mono font-bold">
                    {run.wins}–{run.losses}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-slate-400">
                    {topPlayer(run)?.name} · {topPlayer(run)?.decade} {topPlayer(run)?.team}
                  </span>
                  <span className="shrink-0 font-mono text-slate-500">
                    {run.undefeated ? "PERFECT" : `${run.overall}`}
                  </span>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={onClear}
              className="mt-2 text-[11px] text-slate-500 underline decoration-dotted"
            >
              Clear saved runs
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function topPlayer(run: StoredRun): DraftedPlayer | undefined {
  return [...run.roster].sort((a, b) => b.rating - a.rating)[0];
}

/* ------------------------------------------------------------------- board */

function Board({
  roster,
  spin,
  spinning,
  reelLabels,
  reelIndex,
  reelSpin,
  rerollMsg,
  stuck,
  onPick,
  onRestart,
}: {
  roster: DraftedPlayer[];
  spin: Group | null;
  spinning: boolean;
  reelLabels: string[];
  reelIndex: number;
  reelSpin: boolean;
  rerollMsg: string | null;
  stuck: boolean;
  onPick: (player: Player) => void;
  onRestart: () => void;
}) {
  const pool = spin && !spinning ? eligibleInGroup(spin, roster) : [];
  const open = emptySlots(roster);
  const labels = reelLabels.length > 0 ? reelLabels : ["Tap spin to begin"];

  return (
    <div className="space-y-4 lg:grid lg:grid-cols-[300px_1fr] lg:items-start lg:gap-6 lg:space-y-0">
      <Lineup roster={roster} openCount={open.length} />

      <div className="space-y-4">
        <section className="overflow-hidden rounded-2xl border border-white/10 bg-[#0d1730]">
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
            <h2 className="font-mono text-[10px] uppercase tracking-[0.28em] text-slate-400">
              {spinning ? "Spinning…" : "On the clock"}
            </h2>
            {!spinning && spin ? (
              <span className="font-mono text-[10px] uppercase tracking-widest text-[#f5c451]">
                {pool.length} option{pool.length === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>

          <div className="relative px-4 py-4">
            <div data-testid="reel"
              className="relative h-[76px] overflow-hidden rounded-xl border border-white/10 bg-[#0a1226]">
              <div
                className="will-change-transform"
                style={{
                  transform: `translateY(-${String(reelIndex * REEL_ITEM_PX)}px)`,
                  transition: reelSpin ? `transform ${String(SPIN_MS)}ms cubic-bezier(0.12,0.72,0.12,1)` : "none",
                }}
              >
                {labels.map((label, i) => (
                  <div
                    key={`${label}-${String(i)}`}
                    data-testid="reel-label"
                    className="flex h-[76px] items-center justify-center px-3 text-center text-lg font-black tracking-tight sm:text-xl"
                  >
                    {label}
                  </div>
                ))}
              </div>
            </div>

            {rerollMsg ? (
              <p data-testid="reroll-notice"
              className="mt-3 rounded-xl border border-[#f5c451]/40 bg-[#f5c451]/10 px-3 py-2 text-center text-xs font-semibold text-[#f8d98a]">
                {rerollMsg}
              </p>
            ) : null}

            {stuck ? (
              <button
                type="button"
                onClick={onRestart}
                className="mt-3 h-14 w-full rounded-xl bg-[#f5c451] text-sm font-black uppercase tracking-[0.18em] text-[#0a1020]"
              >
                Start a new run
              </button>
            ) : null}

            {!spinning && spin && pool.length > 0 ? (
              <p className="mt-2 text-center text-[11px] text-slate-400">
                {open.length} slot{open.length === 1 ? "" : "s"} left · tap a player to lock him in
              </p>
            ) : null}
          </div>
        </section>

        {!spinning && spin ? (
          <section className="space-y-2">
            <h2 className="px-1 font-mono text-[10px] uppercase tracking-[0.28em] text-slate-400">
              {spin.label} — available
            </h2>
            {pool.map((player) => {
              const slot = open.find((def) => def.position === player.position);
              return (
                <button
                  key={`${player.name}-${player.decade}`}
                  type="button"
                  onClick={() => onPick(player)}
                  data-testid="pool-player"
                  className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] p-3 text-left transition active:scale-[0.99] hover:border-[#f5c451]/50 hover:bg-white/[0.07]"
                >
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-white/10 font-mono text-sm font-bold text-[#f5c451]">
                    {player.position}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-bold leading-tight">
                      {player.name}
                    </span>
                    <span className="block truncate text-[11px] uppercase tracking-wide text-slate-400">
                      {slot?.label ?? player.position}
                    </span>
                    <StatLine
                      stats={player.stats}
                      testId="pool-player-stats"
                      className="truncate"
                    />
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block font-mono text-xl font-black leading-none text-[#f5c451]">
                      {player.rating}
                    </span>
                    <span className="font-mono text-[9px] uppercase tracking-widest text-slate-500">
                      ovr
                    </span>
                  </span>
                </button>
              );
            })}
          </section>
        ) : null}
      </div>
    </div>
  );
}

function Lineup({ roster, openCount }: { roster: DraftedPlayer[]; openCount: number }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-[#0d1730] p-3 lg:sticky lg:top-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.28em] text-slate-400">
          Starting lineup
        </h2>
        <span className="font-mono text-[10px] text-slate-500">{openCount} open</span>
      </div>
      <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-2">
        {ROSTER_SLOTS.map((def) => {
          const filled = roster.find((d) => d.slot === def.slot);
          return (
            <li
              key={def.slot}
              data-testid={`slot-${def.slot}`}
              className={[
                "min-w-0 rounded-lg border px-2 py-1.5",
                filled
                  ? "border-[#3ddc84]/30 bg-[#3ddc84]/10"
                  : "border-dashed border-white/15 bg-white/[0.02]",
              ].join(" ")}
            >
              <p className="font-mono text-[9px] uppercase tracking-widest text-slate-400">
                {def.slot}
              </p>
              <p
                className={[
                  "truncate text-[11px] font-semibold leading-tight",
                  filled ? "text-[#9df3c0]" : "text-slate-500",
                ].join(" ")}
              >
                {filled ? lastName(filled.name) : "open"}
              </p>
              {filled ? (
                <>
                  <p className="font-mono text-[9px] text-slate-400">OVR {filled.rating}</p>
                  <StatLine
                    pick={filled}
                    testId={`slot-${def.slot}-stats`}
                    variant="tight"
                    className="mt-0.5"
                  />
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------ season */

function Scoreboard({
  roster,
  ratings,
}: {
  roster: DraftedPlayer[];
  ratings: { offense: number; defense: number; special: number; overall: number };
}) {
  return (
    <div className="grid grid-cols-4 gap-2 text-center">
      {[
        { label: "OVR", value: ratings.overall },
        { label: "OFF", value: ratings.offense },
        { label: "DEF", value: ratings.defense },
        { label: "ST", value: ratings.special },
      ].map((stat) => (
        <div key={stat.label} className="rounded-xl border border-white/10 bg-white/[0.03] py-2">
          <p className="font-mono text-[9px] uppercase tracking-widest text-slate-400">
            {stat.label}
          </p>
          <p className="font-mono text-lg font-black text-[#f5c451]">{stat.value.toFixed(1)}</p>
        </div>
      ))}
      <p className="col-span-4 text-[11px] text-slate-400">
        {roster.length} legends on the roster · era- and position-weighted
      </p>
    </div>
  );
}

function SeasonIntro({
  roster,
  ratings,
  onPlay,
}: {
  roster: DraftedPlayer[];
  ratings: { offense: number; defense: number; special: number; overall: number };
  onPlay: () => void;
}) {
  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-white/10 bg-gradient-to-b from-[#13203d] to-[#0d1730] p-5">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-[#f5c451]">
          Lineup complete
        </p>
        <h2 className="mt-1 text-2xl font-black leading-tight">
          11 in the books. Time to play the season.
        </h2>
        <div className="mt-4">
          <Scoreboard roster={roster} ratings={ratings} />
        </div>
        <button
          type="button"
          onClick={onPlay}
          data-testid="play-season"
          className="mt-5 h-16 w-full rounded-2xl bg-[#f5c451] text-lg font-black uppercase tracking-[0.18em] text-[#0a1020] transition active:scale-[0.98]"
        >
          Play the season
        </button>
      </section>
      <RosterList roster={roster} />
    </div>
  );
}

function SeasonLive({
  season,
  revealed,
  onSkip,
}: {
  season: SeasonResult;
  revealed: number;
  onSkip: () => void;
}) {
  const shown = season.weeks.slice(0, revealed);
  const wins = shown.filter((w) => w.win).length;
  const recent = shown.slice(-3).reverse();

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-white/10 bg-[#0d1730] p-4">
        <div className="flex items-end justify-between">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-slate-400">
              Season in progress
            </p>
            <p data-testid="live-record" className="font-mono text-4xl font-black leading-none">
              {wins}
              <span className="text-slate-500">–</span>
              {shown.length - wins}
            </p>
          </div>
          <p className="font-mono text-[11px] text-slate-400">
            Week {shown.length}/{SEASON_GAMES}
          </p>
        </div>

        <div className="mt-4 grid grid-cols-6 gap-1.5">
          {season.weeks.map((week, i) => {
            const done = i < revealed;
            return (
              <div
                key={week.week}
                className={[
                  "grid h-9 place-items-center rounded-md border font-mono text-xs font-bold",
                  !done
                    ? "border-white/10 bg-white/[0.02] text-slate-600"
                    : week.win
                      ? "border-[#3ddc84]/40 bg-[#3ddc84]/15 text-[#9df3c0]"
                      : "border-red-500/40 bg-red-500/15 text-red-300",
                ].join(" ")}
              >
                {done ? (week.win ? "W" : "L") : week.week}
              </div>
            );
          })}
        </div>

        <ul className="mt-4 space-y-1.5">
          {recent.map((week) => (
            <li key={week.week} className="flex items-center gap-3 text-xs">
              <span className="w-10 shrink-0 font-mono text-slate-500">Wk {week.week}</span>
              <span className={week.win ? "font-mono font-bold text-[#9df3c0]" : "font-mono font-bold text-red-300"}>
                {week.teamScore}–{week.oppScore}
              </span>
              <span className="min-w-0 flex-1 truncate text-slate-400">
                {week.win ? "W" : "L"} {week.home ? "vs" : "at"} {week.opponent}
              </span>
            </li>
          ))}
        </ul>

        {revealed < SEASON_GAMES ? (
          <button
            type="button"
            onClick={onSkip}
            data-testid="skip-reveal"
            className="mt-4 h-11 w-full rounded-xl border border-white/15 text-xs font-bold uppercase tracking-widest text-slate-300"
          >
            Skip to final record
          </button>
        ) : null}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ result */

function Result({
  season,
  roster,
  best,
  savedId,
  savedRun,
  unlocked,
  onAgain,
  onHome,
}: {
  season: SeasonResult;
  roster: DraftedPlayer[];
  best: StoredRun | null;
  savedId: string | null;
  savedRun: StoredRun | null;
  /** False on an unpaid device: posting and the rating panel are the unlock. */
  unlocked: boolean;
  onAgain: () => void;
  onHome: () => void;
}) {
  const perfect = season.undefeated;
  const isBest = best !== null && savedId !== null && best.id === savedId;

  return (
    <div className="space-y-4">
      <section
        className={[
          "rounded-2xl border p-5 text-center",
          perfect
            ? "border-[#f5c451]/60 bg-gradient-to-b from-[#3a2c07] to-[#0d1730]"
            : "border-white/10 bg-gradient-to-b from-[#1b2440] to-[#0d1730]",
        ].join(" ")}
      >
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-400">
          Final record
        </p>
        <p
          data-testid="final-record"
          className={[
            "font-mono text-6xl font-black leading-none tracking-tight",
            perfect ? "text-[#f5c451]" : "text-slate-100",
          ].join(" ")}
        >
          {season.wins}–{season.losses}
        </p>
        <p
          data-testid="verdict"
          className={[
            "mt-3 inline-block rounded-full px-4 py-1 font-mono text-xs font-bold uppercase tracking-[0.2em]",
            perfect ? "bg-[#f5c451] text-[#0a1020]" : "bg-white/10 text-slate-300",
          ].join(" ")}
        >
          {perfect ? "Undefeated" : "Not undefeated"}
        </p>
        <p className="mt-3 text-sm text-slate-300">
          {perfect
            ? "Immortal. Every spin paid off — this roster never lost."
            : `${String(season.losses)} game${season.losses === 1 ? "" : "s"} short of immortal. Run it back.`}
        </p>
        <p className="mt-3 font-mono text-[11px] text-slate-400">
          {season.pointsFor} PF · {season.pointsAgainst} PA · roster {season.ratings.overall.toFixed(1)}
        </p>
        {isBest ? (
          <p className="mt-2 font-mono text-[11px] uppercase tracking-widest text-[#f5c451]">
            New best on this device
          </p>
        ) : null}

        <div className="mt-5 space-y-2">
          <button
            type="button"
            onClick={onAgain}
            data-testid="run-again"
            className="h-14 w-full rounded-2xl bg-[#f5c451] text-base font-black uppercase tracking-[0.18em] text-[#0a1020] transition active:scale-[0.98]"
          >
            Run it back
          </button>
          <button
            type="button"
            onClick={onHome}
            data-testid="go-home"
            className="h-12 w-full rounded-2xl border border-white/15 text-xs font-bold uppercase tracking-widest text-slate-300"
          >
            Home &amp; saved runs
          </button>
          {/* The season just played is already on the profile, from whichever
              side holds it — so the result screen is where a player looks at
              their history for the first time. */}
          <Link
            to="/profile"
            data-testid="result-profile-link"
            className="flex h-12 w-full items-center justify-center rounded-2xl border border-white/15 text-xs font-bold uppercase tracking-widest text-slate-300 transition hover:border-[#f5c451]/60 hover:text-slate-100"
          >
            Your profile &amp; seasons
          </Link>
        </div>
      </section>

      {/*
        Free, for everyone: the share card is a finished run's own artifact, not
        a paid feature (repeat runs, posting to the boards and the player rating
        are what the unlock buys). On an unpaid device this is the one thing
        that puts the game in front of someone else.
      */}
      {savedRun ? <ShareResult run={savedRun} /> : null}

      <Scoreboard roster={roster} ratings={season.ratings} />
      {/*
        The poster is mounted only for an unlocked device. An unpaid player gets
        the lock note instead, so nothing can post itself without the purchase.
      */}
      {savedRun ? unlocked ? <SubmitRun run={savedRun} /> : <SubmitLocked /> : null}
      <SeasonScores season={season} />
      <RosterList roster={roster} />
    </div>
  );
}

function SeasonScores({ season }: { season: SeasonResult }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-[#0d1730] p-4">
      <h3 className="font-mono text-[10px] uppercase tracking-[0.28em] text-slate-400">
        Week by week
      </h3>
      <ul className="mt-2 divide-y divide-white/5">
        {season.weeks.map((week) => (
          <li key={week.week} className="flex items-center gap-3 py-1.5 text-xs">
            <span className="w-9 shrink-0 font-mono text-slate-500">{week.week}</span>
            <span className={week.win ? "font-mono font-bold text-[#9df3c0]" : "font-mono font-bold text-red-300"}>
              {week.win ? "W" : "L"}
            </span>
            <span className="w-14 shrink-0 font-mono">
              {week.teamScore}–{week.oppScore}
            </span>
            <span className="min-w-0 flex-1 truncate text-slate-400">
              {week.home ? "vs" : "at"} {week.opponent}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RosterList({ roster }: { roster: DraftedPlayer[] }) {
  if (roster.length === 0) return null;
  return (
    <section className="rounded-2xl border border-white/10 bg-[#0d1730] p-4">
      <h3 className="font-mono text-[10px] uppercase tracking-[0.28em] text-slate-400">
        Your immortals
      </h3>
      <ul className="mt-2 divide-y divide-white/5">
        {roster.map((player) => (
          <li key={player.slot} className="flex items-center gap-3 py-2">
            <span className="grid h-8 w-10 shrink-0 place-items-center rounded-md bg-white/10 font-mono text-[11px] font-bold text-[#f5c451]">
              {player.slot}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{player.name}</span>
              <span className="block truncate text-[11px] text-slate-400">
                {player.decade} {player.team}
              </span>
              <StatLine pick={player} testId="roster-player-stats" className="truncate" />
            </span>
            <span className="shrink-0 font-mono text-sm font-bold text-slate-200">
              {player.rating}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
