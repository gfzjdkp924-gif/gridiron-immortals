import { Link, createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import SiteFooter from "~/components/SiteFooter";
import { fetchPlayersBoard } from "~/lib/players-board-api";
import { useEntitlement } from "~/lib/entitlement";
import { STORE_BUILD } from "~/lib/build-flags";
import { PLAYERS_LOCK_NOTE, BUY_URL, BUY_LABEL } from "~/lib/paywall";
import {
  MIN_SEASONS,
  RATING_BASE,
  TIERS,
  UNDEFEATED_BONUS,
  WIN_POINT,
  bestRecord,
  type PlayerRow,
  type PlayersBoardData,
} from "~/lib/player-rating";
import { ensureDeviceToken } from "~/lib/storage";

export const Route = createFileRoute("/players")({
  head: () => ({
    meta: [
      { title: "Players board — Gridiron Immortals" },
      {
        name: "description",
        content:
          "Every game player ranked by rating: the average of their posted seasons, scored on how far each result beat what their drafted roster was worth. Free to read.",
      },
    ],
  }),
  component: PlayersPage,
});

const TIER_STYLE: Record<string, string> = {
  "Hall of Fame": "bg-[#f5c451] text-[#0a1020]",
  "All-Pro": "bg-[#f5c451]/25 text-[#f8d98a] border border-[#f5c451]/50",
  "Pro Bowl": "bg-white/10 text-slate-200 border border-white/20",
  Starter: "bg-white/5 text-slate-300 border border-white/15",
  Rookie: "bg-white/5 text-slate-400 border border-white/10",
};

function TierBadge({ tier, testId }: { tier: string; testId?: string }) {
  return (
    <span
      data-testid={testId}
      className={[
        "rounded-full px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-widest",
        TIER_STYLE[tier] ?? TIER_STYLE.Rookie,
      ].join(" ")}
    >
      {tier}
    </span>
  );
}

function PlayersPage() {
  const [board, setBoard] = useState<PlayersBoardData | null>(null);
  const [loading, setLoading] = useState(true);
  // The device token is read after mount so the server-rendered markup and the
  // first client pass are identical.
  const [token, setToken] = useState<string | null>(null);

  // The board renders for everyone; this only decides whether the lock note
  // explaining what the unlock buys is shown above it.
  const entitlement = useEntitlement();

  const load = useCallback((deviceToken: string | null) => {
    setLoading(true);
    void fetchPlayersBoard(deviceToken).then((data) => {
      setBoard(data);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    const deviceToken = ensureDeviceToken();
    setToken(deviceToken);
    load(deviceToken);
  }, [load]);

  const rows = useMemo(() => board?.entries ?? [], [board]);
  const you = board?.you ?? null;

  return (
    <div className="min-h-dvh bg-[#070c17] text-slate-100">
      <div className="mx-auto w-full max-w-md px-4 pb-10 pt-5 lg:max-w-3xl lg:px-8">
        <header className="mb-4 flex items-end justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-[#f5c451]">
              Career rating
            </p>
            <h1 className="text-xl font-black uppercase leading-none tracking-tight sm:text-2xl">
              Players <span className="text-[#f5c451]">board</span>
            </h1>
          </div>
          <div className="flex shrink-0 gap-2">
            <Link
              to="/profile"
              data-testid="players-profile-link"
              className="rounded-full border border-white/15 px-3 py-2 text-[11px] font-bold uppercase tracking-widest text-slate-300 transition hover:border-[#f5c451]/60"
            >
              Profile
            </Link>
            <Link
              to="/leaderboard"
              data-testid="players-runs-link"
              className="rounded-full border border-white/15 px-3 py-2 text-[11px] font-bold uppercase tracking-widest text-slate-300 transition hover:border-[#f5c451]/60"
            >
              Runs
            </Link>
            <Link
              to="/"
              data-testid="players-back"
              className="rounded-full border border-white/15 px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-slate-300 transition hover:border-[#f5c451]/60 hover:text-slate-100"
            >
              Play
            </Link>
          </div>
        </header>

        <div data-testid="players-page" className="space-y-4">
          {/* The web build's "free to read, rating comes with the $4.99 unlock"
              note. A store build has nothing to sell, so the note — and the buy
              link in it — is not in that bundle at all. */}
          {!STORE_BUILD && entitlement.loaded && !entitlement.unlocked ? <PlayersLockNote /> : null}

          {loading && board === null ? (
            <section className="rounded-2xl border border-white/10 bg-[#0d1730] p-5">
              <p data-testid="players-loading" className="text-sm text-slate-400">
                Loading the players board…
              </p>
            </section>
          ) : null}

          {board !== null && !board.connected ? (
            <>
              <OfflinePlayers offline={board.offline === true} onRetry={() => load(token)} />
              {/* The scale is static data, so it is worth showing even with no
                  database: a player can read what a rating means right now. */}
              <section className="rounded-2xl border border-white/10 bg-[#0d1730] p-4">
                <h2 className="font-mono text-[10px] uppercase tracking-[0.28em] text-slate-400">
                  How a rating works
                </h2>
                <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
                  A rating is the average of every posted season. Each season scores{" "}
                  {RATING_BASE} for doing exactly what the drafted roster was worth, plus{" "}
                  {WIN_POINT} for every win above that (and −{WIN_POINT} for every win below), plus{" "}
                  {UNDEFEATED_BONUS} for a 17–0. Weak rosters over-performing earn more. It takes{" "}
                  {MIN_SEASONS} posted seasons to appear on the board.
                </p>
              </section>
              <TierTable tiers={TIERS} />
            </>
          ) : null}

          {board !== null && board.connected ? (
            <>
              <section
                data-testid="players-summary"
                className="rounded-2xl border border-white/10 bg-gradient-to-b from-[#13203d] to-[#0d1730] p-5"
              >
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-slate-400">
                      Ranked players
                    </p>
                    <p
                      data-testid="players-total"
                      className="font-mono text-4xl font-black leading-none text-[#f5c451]"
                    >
                      {board.total}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-slate-400">
                      Identities
                    </p>
                    <p className="font-mono text-2xl font-black leading-none text-slate-100">
                      {board.identities}
                    </p>
                  </div>
                </div>
                <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
                  A rating is the average of every posted season. Each season scores 1000 for
                  doing exactly what the drafted roster was worth, plus 45 a win above that (and −45
                  a win below), plus 50 for a 17–0. Weak rosters over-performing earn more. It takes{" "}
                  {board.minSeasons} completed seasons to appear; top {rows.length} of {board.total}{" "}
                  shown.
                </p>
                <button
                  type="button"
                  onClick={() => load(token)}
                  data-testid="players-refresh"
                  className="mt-3 h-10 w-full rounded-xl border border-white/15 text-[11px] font-bold uppercase tracking-widest text-slate-300 transition hover:border-[#f5c451]/60"
                >
                  Refresh
                </button>
              </section>

              {you ? <YouCard standing={you} minSeasons={board.minSeasons} /> : null}

              <TierTable tiers={board.tiers} />

              {rows.length === 0 ? (
                <section className="rounded-2xl border border-white/10 bg-[#0d1730] p-5">
                  <p data-testid="players-empty" className="text-sm text-slate-300">
                    Nobody has finished {board.minSeasons} seasons yet. Play a season, post it, and
                    your rating starts building — {board.minSeasons} completed seasons puts you on
                    this board.
                  </p>
                </section>
              ) : (
                <section className="space-y-2">
                  {rows.map((row) => (
                    <PlayerBoardRow key={`${row.rank}-${row.name}`} row={row} />
                  ))}
                </section>
              )}
            </>
          ) : null}
        </div>

        {/* Reachable from here because this board is public and a stranger can
            land on it first from a shared link. */}
        <SiteFooter play />
      </div>
    </div>
  );
}

function PlayerBoardRow({ row }: { row: PlayerRow }) {
  return (
    <article
      data-testid="players-row"
      data-you={row.you ? "true" : "false"}
      className={[
        "rounded-2xl border p-3",
        row.you
          ? "border-[#f5c451]/50 bg-gradient-to-b from-[#3a2c07] to-[#0d1730]"
          : "border-white/10 bg-[#0d1730]",
      ].join(" ")}
    >
      <div className="flex items-baseline gap-3">
        <span className="w-7 shrink-0 font-mono text-sm font-bold text-slate-500">{row.rank}</span>
        <span className="min-w-0 flex-1 truncate text-[15px] font-bold">{row.name}</span>
        <span
          data-testid="players-rating"
          className="shrink-0 font-mono text-lg font-black leading-none text-[#f5c451]"
        >
          {row.rating.toFixed(1)}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-10">
        <TierBadge tier={row.tier} testId="players-tier" />
        <span className="font-mono text-[11px] text-slate-400">
          {row.seasons} season{row.seasons === 1 ? "" : "s"}
        </span>
        <span className="font-mono text-[11px] text-slate-500">
          best {bestRecord(row)}
          {row.perfectSeasons > 0 ? ` · ${row.perfectSeasons}×17–0` : ""}
        </span>
        {row.you ? (
          <span className="rounded-full bg-[#f5c451] px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-widest text-[#0a1020]">
            You
          </span>
        ) : null}
      </div>
    </article>
  );
}

/** The caller's own rating, shown even before the seasons gate is cleared. */
function YouCard({
  standing,
  minSeasons,
}: {
  standing: NonNullable<PlayersBoardData["you"]>;
  minSeasons: number;
}) {
  return (
    <section
      data-testid="players-you"
      className="rounded-2xl border border-white/10 bg-[#0d1730] p-4"
    >
      <h2 className="font-mono text-[10px] uppercase tracking-[0.28em] text-slate-400">
        Your rating
      </h2>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div>
          <p
            data-testid="you-rating"
            className="font-mono text-3xl font-black leading-none text-[#f5c451]"
          >
            {standing.rating.toFixed(1)}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            {standing.name} · {standing.seasons} season{standing.seasons === 1 ? "" : "s"} ·{" "}
            {standing.wins}–{standing.losses} all-time
          </p>
        </div>
        <div className="text-right">
          <TierBadge tier={standing.tier} testId="you-tier" />
          <p className="mt-1 font-mono text-[11px] text-slate-400">
            {standing.qualified
              ? standing.rank !== null
                ? `#${String(standing.rank)} on the board`
                : "On the board"
              : `${String(standing.seasonsToQualify)} more season${standing.seasonsToQualify === 1 ? "" : "s"} to be ranked`}
          </p>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-slate-500">
        {standing.nextTier
          ? `${(standing.nextTier.min - standing.rating).toFixed(1)} rating to ${standing.nextTier.tier}.`
          : "Top tier. Nothing left to prove."}{" "}
        {standing.qualified
          ? ""
          : `Every posted season counts; ${minSeasons} are needed to appear.`}
      </p>
    </section>
  );
}

/** The thresholds, on the page — never a hidden number. */
function TierTable({ tiers }: { tiers: PlayersBoardData["tiers"] }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-[#0d1730] p-4">
      <h2 className="font-mono text-[10px] uppercase tracking-[0.28em] text-slate-400">Tiers</h2>
      <ul data-testid="players-tiers" className="mt-2 divide-y divide-white/5">
        {tiers.map((band, index) => {
          // TIERS is descending, so the band above sets this band's ceiling.
          const above = tiers[index - 1];
          const range = above ? `${band.min}–${above.min - 1}` : `${band.min}+`;
          return (
            <li key={band.tier} className="flex items-center gap-3 py-2">
              <TierBadge tier={band.tier} />
              <span className="min-w-0 flex-1 truncate text-[11px] text-slate-400">{band.note}</span>
              <span className="shrink-0 font-mono text-[11px] font-bold text-slate-300">
                {range}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PlayersLockNote() {
  return (
    <section
      data-testid="players-locked"
      className="rounded-2xl border border-[#f5c451]/40 bg-[#f5c451]/10 px-3 py-2"
    >
      <p className="text-[11px] leading-snug text-[#f8d98a]">
        {PLAYERS_LOCK_NOTE}{" "}
        <a
          href={BUY_URL}
          target="_blank"
          rel="noreferrer"
          data-testid="players-locked-buy"
          className="font-semibold whitespace-nowrap underline decoration-dotted"
        >
          {BUY_LABEL}
        </a>
      </p>
    </section>
  );
}

/** Offline is a different sentence from "the board has nowhere to store a rating". */
function OfflinePlayers({ offline, onRetry }: { offline: boolean; onRetry: () => void }) {
  return (
    <section
      data-testid="players-offline"
      data-offline={offline ? "true" : "false"}
      className="rounded-2xl border border-white/10 bg-[#0d1730] p-5"
    >
      <h2 className="text-lg font-black leading-tight">
        {offline ? "You're offline" : "The players board can't store ratings right now"}
      </h2>
      <p className="mt-2 text-sm text-slate-300">
        {offline
          ? "Ratings are stored on a server, and this device has no network right now, so the board can't be read. Nothing else changes — the game plays offline, your runs and rating history keep saving here, and every season you post counts once you're back online."
          : "A rating is worked out on the server from the seasons you post, and the board has nowhere to keep one at the moment. Nothing else changes — spin, draft all 11, and play the season as usual. Your runs and your rating history keep saving on this device, and every season you post counts as soon as the board's storage is back."}
      </p>
      <Link
        to="/"
        data-testid="players-offline-play"
        className="mt-4 inline-block h-12 w-full rounded-2xl bg-[#f5c451] text-center text-sm font-black uppercase leading-[3rem] tracking-[0.18em] text-[#0a1020]"
      >
        Back to the game
      </Link>
      <button
        type="button"
        onClick={onRetry}
        data-testid="players-retry"
        className="mt-2 h-11 w-full rounded-xl border border-white/15 text-[11px] font-bold uppercase tracking-widest text-slate-300 transition hover:border-[#f5c451]/60"
      >
        Try again
      </button>
    </section>
  );
}
