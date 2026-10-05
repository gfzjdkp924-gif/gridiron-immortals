import { Link, createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import SiteFooter from "~/components/SiteFooter";
import { fetchBoard } from "~/lib/board-api";
import { useEntitlement } from "~/lib/entitlement";
import { STORE_BUILD } from "~/lib/build-flags";
import { headlinePicks, record, type BoardData, type LeaderboardEntry } from "~/lib/leaderboard";
import { BOARD_LOCK_NOTE, BUY_URL, BUY_LABEL } from "~/lib/paywall";

export const Route = createFileRoute("/leaderboard")({
  head: () => ({
    meta: [
      { title: "Global leaderboard — Gridiron Immortals" },
      {
        name: "description",
        content:
          "Every season Gridiron Immortals players have posted, on one board: most wins first, then roster rating. Free to read.",
      },
    ],
  }),
  component: LeaderboardPage,
});

const formatDate = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

function LeaderboardPage() {
  const [board, setBoard] = useState<BoardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [perfectOnly, setPerfectOnly] = useState(false);

  // The board renders for everyone; this only decides whether the lock note
  // explaining what the unlock buys is shown above it.
  const entitlement = useEntitlement();

  const load = useCallback(() => {
    setLoading(true);
    void fetchBoard().then((data) => {
      setBoard(data);
      setLoading(false);
    });
  }, []);

  // Fetched after mount so the shell (and the offline state) render first.
  useEffect(() => {
    load();
  }, [load]);

  // Ranks come from the full board, so filtering never renumbers anyone:
  // #1 stays #1 whether or not the 3–14 runs are hidden.
  const ranked = useMemo(
    () => (board?.entries ?? []).map((entry, index) => ({ entry, rank: index + 1 })),
    [board],
  );
  const perfectCount = ranked.filter((row) => row.entry.undefeated).length;
  const rows = perfectOnly ? ranked.filter((row) => row.entry.undefeated) : ranked;

  return (
    <div className="min-h-dvh bg-[#070c17] text-slate-100">
      <div className="mx-auto w-full max-w-md px-4 pb-10 pt-5 lg:max-w-3xl lg:px-8">
        <header className="mb-4 flex items-end justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-[#f5c451]">
              All-time board
            </p>
            <h1 className="text-xl font-black uppercase leading-none tracking-tight sm:text-2xl">
              Global <span className="text-[#f5c451]">leaderboard</span>
            </h1>
          </div>
          <div className="flex shrink-0 gap-2">
            <Link
              to="/profile"
              data-testid="board-profile-link"
              className="rounded-full border border-white/15 px-3 py-2 text-[11px] font-bold uppercase tracking-widest text-slate-300 transition hover:border-[#f5c451]/60"
            >
              Profile
            </Link>
            <Link
              to="/players"
              data-testid="board-players-link"
              className="rounded-full border border-white/15 px-3 py-2 text-[11px] font-bold uppercase tracking-widest text-slate-300 transition hover:border-[#f5c451]/60"
            >
              Players
            </Link>
            <Link
              to="/"
              data-testid="board-back"
              className="rounded-full border border-white/15 px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-slate-300 transition hover:border-[#f5c451]/60 hover:text-slate-100"
            >
              Play
            </Link>
          </div>
        </header>

        <div data-testid="leaderboard-page" className="space-y-4">
          {/* The web build's "free to read, post with the $4.99 unlock" note. A
              store build has nothing to sell, so the note — and the buy link in
              it — is not in that bundle at all. */}
          {!STORE_BUILD && entitlement.loaded && !entitlement.unlocked ? <BoardLockNote /> : null}

          {loading && board === null ? (
            <section className="rounded-2xl border border-white/10 bg-[#0d1730] p-5">
              <p data-testid="board-loading" className="text-sm text-slate-400">
                Loading the board…
              </p>
            </section>
          ) : null}

          {board !== null && !board.connected ? (
            <OfflineBoard offline={board.offline === true} onRetry={load} />
          ) : null}

          {board !== null && board.connected ? (
            <>
              <section
                data-testid="board-connected"
                className="rounded-2xl border border-white/10 bg-gradient-to-b from-[#13203d] to-[#0d1730] p-5"
              >
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-slate-400">
                      Seasons submitted
                    </p>
                    <p
                      data-testid="board-total"
                      className="font-mono text-4xl font-black leading-none text-[#f5c451]"
                    >
                      {board.total}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-slate-400">
                      Perfect
                    </p>
                    <p className="font-mono text-2xl font-black leading-none text-slate-100">
                      {perfectCount}
                      <span className="text-sm text-slate-500"> / {board.entries.length}</span>
                    </p>
                  </div>
                </div>
                <p className="mt-3 text-[11px] text-slate-400">
                  Every posted season is ranked — most wins first, then roster rating, then
                  earliest submission. Top {board.entries.length} of {board.total} shown.
                </p>
                {/* Measured 2026-10-04, twice over: a redeploy replaces the running
                    server's whole tree, so the board is kept by SHIPPING it. The
                    document lives in the site's own `.data` and is carried forward
                    into each publish (src/server/file-store.ts; the sync that makes
                    it current is tools/board-sync.sh, run before every publish).
                    Nothing here may promise a permanent archive: the board is
                    durable across updates, not perpetual, and a season posted in the
                    seconds around a deploy can still miss that deploy's copy. Your
                    own runs never depend on the board — they are on your device. */}
                <p data-testid="board-durability" className="mt-2 text-[11px] text-slate-500">
                  The board is kept with the game itself and carried forward with each update,
                  so posted seasons stay on it. Your own runs are also saved on your device.
                </p>
                <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
                  <p className="text-[11px] leading-tight text-slate-300">
                    Perfect seasons only
                    <span className="block text-[10px] text-slate-500">
                      {perfectCount} on the board
                    </span>
                  </p>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={perfectOnly}
                    onClick={() => setPerfectOnly((on) => !on)}
                    data-testid="board-perfect-filter"
                    aria-label="Show perfect seasons only"
                    className={[
                      "flex h-7 w-14 shrink-0 items-center rounded-full border px-0.5 transition",
                      perfectOnly
                        ? "justify-end border-[#f5c451]/60 bg-[#f5c451]/25"
                        : "justify-start border-white/20 bg-white/5",
                    ].join(" ")}
                  >
                    <span
                      className={[
                        "h-5 w-5 rounded-full transition",
                        perfectOnly ? "bg-[#f5c451]" : "bg-slate-500",
                      ].join(" ")}
                    />
                  </button>
                </div>
                <button
                  type="button"
                  onClick={load}
                  data-testid="board-refresh"
                  className="mt-3 h-10 w-full rounded-xl border border-white/15 text-[11px] font-bold uppercase tracking-widest text-slate-300 transition hover:border-[#f5c451]/60"
                >
                  Refresh
                </button>
              </section>

              {board.entries.length === 0 ? (
                <section className="rounded-2xl border border-white/10 bg-[#0d1730] p-5">
                  <p data-testid="board-empty" className="text-sm text-slate-300">
                    Nothing on the board yet. Post a season and it lands here — a 17–0 and a 3–14
                    both get ranked.
                  </p>
                </section>
              ) : rows.length === 0 ? (
                <section className="rounded-2xl border border-white/10 bg-[#0d1730] p-5">
                  <p data-testid="board-filter-empty" className="text-sm text-slate-300">
                    No perfect seasons on the board yet. Every 17–0 run shows up here as soon as one
                    lands.
                  </p>
                </section>
              ) : (
                <section className="space-y-2">
                  {rows.map(({ entry, rank }) => (
                    <BoardRow key={entry.id} entry={entry} rank={rank} />
                  ))}
                </section>
              )}
            </>
          ) : null}
        </div>

        {/* A stranger can land on this page first from a shared link, so the
            privacy policy and support are reachable from here, not only from
            the game. */}
        <SiteFooter play />
      </div>
    </div>
  );
}

function BoardRow({ entry, rank }: { entry: LeaderboardEntry; rank: number }) {
  const legends = headlinePicks(entry.lineup, 3);
  return (
    <article
      data-testid="board-row"
      data-perfect={entry.undefeated ? "true" : "false"}
      className={[
        "rounded-2xl border p-3",
        entry.undefeated
          ? "border-[#f5c451]/50 bg-gradient-to-b from-[#3a2c07] to-[#0d1730]"
          : "border-white/10 bg-[#0d1730]",
      ].join(" ")}
    >
      <div className="flex items-baseline gap-3">
        <span className="w-7 shrink-0 font-mono text-sm font-bold text-slate-500">{rank}</span>
        <span className="min-w-0 flex-1 truncate text-[15px] font-bold">{entry.name}</span>
        <span className="shrink-0 font-mono text-lg font-black leading-none">
          {record(entry.wins, entry.losses)}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-2 pl-10">
        {entry.undefeated ? (
          <span className="rounded-full bg-[#f5c451] px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-widest text-[#0a1020]">
            Perfect
          </span>
        ) : null}
        <span className="font-mono text-[11px] text-[#f5c451]">OVR {entry.overall.toFixed(1)}</span>
        <span className="font-mono text-[11px] text-slate-500">{formatDate(entry.createdAt)}</span>
      </div>
      {legends.length > 0 ? (
        <p className="mt-2 truncate pl-10 text-[11px] text-slate-400">
          {legends.map((p) => `${p.name} (${p.position})`).join(" · ")}
        </p>
      ) : null}
    </article>
  );
}

/**
 * The lock note for an unpaid device. Reading the board is free and stays free —
 * this says so, because the board is right underneath it.
 */
function BoardLockNote() {
  return (
    <section
      data-testid="board-locked"
      className="rounded-2xl border border-[#f5c451]/40 bg-[#f5c451]/10 px-3 py-2"
    >
      <p className="text-[11px] leading-snug text-[#f8d98a]">
        {BOARD_LOCK_NOTE}{" "}
        <a
          href={BUY_URL}
          target="_blank"
          rel="noreferrer"
          data-testid="board-locked-buy"
          className="font-semibold whitespace-nowrap underline decoration-dotted"
        >
          {BUY_LABEL}
        </a>
      </p>
    </section>
  );
}

/**
 * Two different things land here, and the player is told which one it is:
 * `offline` (this device has no network — the board is fine, you aren't) versus
 * the board having nowhere to store a run (its own storage could not be
 * written). Blaming the wrong one sends people looking for a problem that isn't
 * theirs.
 */
function OfflineBoard({ offline, onRetry }: { offline: boolean; onRetry: () => void }) {
  return (
    <section
      data-testid="board-offline"
      data-offline={offline ? "true" : "false"}
      className="rounded-2xl border border-white/10 bg-[#0d1730] p-5"
    >
      <h2 className="text-lg font-black leading-tight">
        {offline ? "You're offline" : "The leaderboard can't store runs right now"}
      </h2>
      <p className="mt-2 text-sm text-slate-300">
        {offline
          ? "This device has no network right now, so the board — which lives on a server — can't be read. Nothing else changes: spin, draft all 11 and play the whole season offline, and your runs keep saving here. The board will be there when you reconnect."
          : "Runs are ranked on the server, and the board has nowhere to keep one at the moment. Nothing else changes — spin, draft all 11, and play the season as usual. Your runs keep saving on this device, and every season you post can go on the board as soon as its storage is back."}
      </p>
      <Link
        to="/"
        data-testid="board-offline-play"
        className="mt-4 inline-block h-12 w-full rounded-2xl bg-[#f5c451] text-center text-sm font-black uppercase leading-[3rem] tracking-[0.18em] text-[#0a1020]"
      >
        Back to the game
      </Link>
      <button
        type="button"
        onClick={onRetry}
        data-testid="board-retry"
        className="mt-2 h-11 w-full rounded-xl border border-white/15 text-[11px] font-bold uppercase tracking-widest text-slate-300 transition hover:border-[#f5c451]/60"
      >
        Try again
      </button>
    </section>
  );
}
