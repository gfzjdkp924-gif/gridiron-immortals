/**
 * /profile — one player's seasons.
 *
 * WHAT IT SHOWS, AND WHERE EACH PART COMES FROM (this is the page's contract,
 * not a description of the markup):
 *
 *  - Every season this player has finished, newest first, with the record, the
 *    roster rating, the date and the full 11-man lineup including each pick's
 *    team and era.
 *  - The best run, and the standing rating and band from the players board.
 *  - TWO SOURCES, merged and de-duplicated by src/lib/profile.ts: the seasons
 *    the BOARD holds for this device (matched by the one-way key of its token,
 *    never by name) and the seasons this DEVICE saved itself. A season that is
 *    only on the device is marked as not posted — never quietly shown as if the
 *    server had it.
 *
 * NO ACCOUNT, NO PASSWORD, NO EMAIL. The page reads the device token the game
 * already has, and reads the device's own runs. Reading it is free, like both
 * boards; nothing here is behind the unlock.
 */
import { Link, createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import SiteFooter from "~/components/SiteFooter";
import { fetchProfile } from "~/lib/profile-api";
import {
  PROFILE_ATTRIBUTION_FALLBACK,
  bestProfileSeason,
  mergeProfileSeasons,
  profileRecord,
  type ProfileData,
  type ProfileSeasonRow,
} from "~/lib/profile";
import type { PlayerStanding } from "~/lib/player-rating";
import {
  ensureDeviceToken,
  loadIdentity,
  loadRuns,
  loadSubmissions,
  type BoardSubmission,
  type StoredRun,
} from "~/lib/storage";

export const Route = createFileRoute("/profile")({
  head: () => ({
    meta: [
      { title: "Your profile — Gridiron Immortals" },
      {
        name: "description",
        content:
          "Every season this device has finished, posted or not: the record, the roster rating, the lineup and the player rating. No account, no password, no email.",
      },
    ],
  }),
  component: ProfilePage,
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

const formatDay = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};

function ProfilePage() {
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  // The device's own records. Read after mount so the server-rendered markup and
  // the first client pass are identical.
  const [runs, setRuns] = useState<StoredRun[]>([]);
  const [submissions, setSubmissions] = useState<Record<string, BoardSubmission>>({});
  const [token, setToken] = useState<string | null>(null);
  const [localName, setLocalName] = useState<string | null>(null);

  const load = useCallback((deviceToken: string | null) => {
    setLoading(true);
    void fetchProfile(deviceToken).then((data) => {
      setProfile(data);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    const deviceToken = ensureDeviceToken();
    setToken(deviceToken);
    setRuns(loadRuns());
    setSubmissions(loadSubmissions());
    setLocalName(loadIdentity()?.name ?? null);
    load(deviceToken);
  }, [load]);

  const rows = useMemo(
    () => mergeProfileSeasons(profile?.seasons ?? [], runs, submissions),
    [profile, runs, submissions],
  );
  const best = useMemo(() => bestProfileSeason(rows), [rows]);
  const totals = useMemo(
    () =>
      rows.reduce(
        (sum, row) => ({ wins: sum.wins + row.wins, losses: sum.losses + row.losses }),
        { wins: 0, losses: 0 },
      ),
    [rows],
  );
  const standing: PlayerStanding | null = profile?.player ?? null;
  const displayName = standing?.name ?? localName;
  const unreadable = profile !== null && !profile.connected;

  return (
    <div className="min-h-dvh bg-[#070c17] text-slate-100">
      <div className="mx-auto w-full max-w-md px-4 pb-10 pt-5 lg:max-w-3xl lg:px-8">
        <header className="mb-4 flex items-end justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-[#f5c451]">
              Seasons &amp; standing
            </p>
            <h1 className="text-xl font-black uppercase leading-none tracking-tight sm:text-2xl">
              Your <span className="text-[#f5c451]">profile</span>
            </h1>
          </div>
          <div className="flex shrink-0 gap-2">
            <Link
              to="/leaderboard"
              data-testid="profile-runs-link"
              className="rounded-full border border-white/15 px-3 py-2 text-[11px] font-bold uppercase tracking-widest text-slate-300 transition hover:border-[#f5c451]/60"
            >
              Runs
            </Link>
            <Link
              to="/players"
              data-testid="profile-players-link"
              className="rounded-full border border-white/15 px-3 py-2 text-[11px] font-bold uppercase tracking-widest text-slate-300 transition hover:border-[#f5c451]/60"
            >
              Players
            </Link>
            <Link
              to="/"
              data-testid="profile-back"
              className="rounded-full border border-white/15 px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-slate-300 transition hover:border-[#f5c451]/60 hover:text-slate-100"
            >
              Play
            </Link>
          </div>
        </header>

        <div data-testid="profile-page" className="space-y-4">
          {loading && profile === null ? (
            <section className="rounded-2xl border border-white/10 bg-[#0d1730] p-5">
              <p data-testid="profile-loading" className="text-sm text-slate-400">
                Loading your seasons…
              </p>
            </section>
          ) : null}

          {unreadable ? (
            <UnreadableProfile
              offline={profile?.offline === true}
              onRetry={() => load(token)}
            />
          ) : null}

          {profile !== null && profile.connected ? (
            <SummaryCard
              name={displayName}
              standing={standing}
              best={best}
              seasons={rows.length}
              wins={totals.wins}
              losses={totals.losses}
            />
          ) : null}

          {profile !== null ? (
            <p data-testid="profile-device-note" className="px-1 text-[11px] leading-relaxed text-slate-500">
              A profile travels with the device that played the seasons — this browser and the
              display name it posts under. Without a real account it cannot follow you to a new
              phone. No signup, no password, no email.
            </p>
          ) : null}

          {rows.length > 0 ? (
            <section className="space-y-3">
              <h2 className="px-1 font-mono text-[10px] uppercase tracking-[0.28em] text-slate-400">
                Seasons · {rows.length}
              </h2>
              <ul data-testid="profile-seasons" className="space-y-3">
                {rows.map((row) => (
                  <SeasonCard key={row.key} row={row} />
                ))}
              </ul>
            </section>
          ) : null}

          {profile !== null && profile.connected && rows.length === 0 ? (
            <section className="rounded-2xl border border-white/10 bg-[#0d1730] p-5">
              <p data-testid="profile-empty" className="text-sm text-slate-300">
                No seasons yet. Play one and it lands here — the season you have already finished
                stays on this device whether or not it is posted, and a posted one is kept on the
                board and carried forward with every update.
              </p>
            </section>
          ) : null}

          {profile !== null && profile.connected ? (
            <p data-testid="profile-attribution" className="px-1 text-[11px] leading-relaxed text-slate-500">
              {profile.attribution || PROFILE_ATTRIBUTION_FALLBACK}
            </p>
          ) : null}
        </div>

        <SiteFooter play />
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- standing */

function SummaryCard({
  name,
  standing,
  best,
  seasons,
  wins,
  losses,
}: {
  name: string | null;
  standing: PlayerStanding | null;
  best: ProfileSeasonRow | null;
  seasons: number;
  wins: number;
  losses: number;
}) {
  return (
    <section
      data-testid="profile-summary"
      className="rounded-2xl border border-white/10 bg-gradient-to-b from-[#13203d] to-[#0d1730] p-5"
    >
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-slate-400">
            {name ?? "This device"}
          </p>
          <p
            data-testid="profile-best-run"
            className="font-mono text-4xl font-black leading-none text-[#f5c451]"
          >
            {best ? profileRecord(best.wins, best.losses) : "—"}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            {best
              ? `Best run · roster ${best.overall.toFixed(1)}${best.undefeated ? " · UNDEFEATED" : ""}`
              : "Best run appears after your first season"}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-slate-400">Rating</p>
          <p
            data-testid="profile-rating"
            className="font-mono text-2xl font-black leading-none text-slate-100"
          >
            {standing ? standing.rating.toFixed(1) : "—"}
          </p>
          <div className="mt-1 flex justify-end">
            {standing ? (
              <TierBadge tier={standing.tier} testId="profile-tier" />
            ) : (
              <span
                data-testid="profile-tier"
                className="rounded-full border border-white/15 bg-white/5 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-widest text-slate-400"
              >
                No rating yet
              </span>
            )}
          </div>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
        <Stat label="Seasons" value={String(seasons)} testId="profile-seasons-count" />
        <Stat label="Record" value={profileRecord(wins, losses)} testId="profile-record" />
        <Stat
          label={standing?.qualified ? "Board rank" : "Posted"}
          value={
            standing
              ? standing.qualified && standing.rank !== null
                ? `#${String(standing.rank)}`
                : "unranked"
              : "—"
          }
          testId="profile-rank"
        />
      </dl>

      <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
        {standing
          ? standing.qualified
            ? `Ranked on the players board from ${String(standing.seasons)} posted season${standing.seasons === 1 ? "" : "s"}.`
            : `Your rating is building — ${String(standing.seasonsToQualify)} more posted season${standing.seasonsToQualify === 1 ? "" : "s"} to appear on the players board.`
          : "A rating is worked out from the seasons you post, so it appears once a season is on the board."}
      </p>
    </section>
  );
}

function Stat({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-2 py-2">
      <dt className="font-mono text-[9px] uppercase tracking-widest text-slate-400">{label}</dt>
      <dd data-testid={testId} className="font-mono text-base font-black leading-tight text-slate-100">
        {value}
      </dd>
    </div>
  );
}

/* ---------------------------------------------------------------- seasons */

function SourceMarker({ row }: { row: ProfileSeasonRow }) {
  if (row.source === "board") {
    return (
      <p data-testid="profile-season-source" data-source="board" className="font-mono text-[10px] uppercase tracking-wider text-[#9df3c0]">
        Posted
        {row.rank !== null ? ` · #${String(row.rank)} of ${String(row.total)} on the board` : " · on the board"}
      </p>
    );
  }
  if (row.source === "device-posted") {
    return (
      <p
        data-testid="profile-season-source"
        data-source="device-posted"
        className="font-mono text-[10px] uppercase tracking-wider text-[#f8d98a]"
      >
        Posted from this device · the board&rsquo;s copy is not there now
      </p>
    );
  }
  return (
    <p data-testid="profile-season-source" data-source="device-only" className="flex flex-wrap items-center gap-1.5">
      <span
        data-testid="profile-device-only"
        className="rounded-full border border-white/20 bg-white/5 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-widest text-slate-300"
      >
        This device only
      </span>
      <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400">
        not posted to the board
      </span>
    </p>
  );
}

function SeasonCard({ row }: { row: ProfileSeasonRow }) {
  return (
    <li
      data-testid="profile-season"
      data-source={row.source}
      className={[
        "rounded-2xl border p-4",
        row.onBoard ? "border-[#f5c451]/40 bg-[#0d1730]" : "border-white/10 bg-[#0d1730]",
      ].join(" ")}
    >
      <div className="flex items-baseline justify-between gap-3">
        <p
          data-testid="profile-season-record"
          className="font-mono text-3xl font-black leading-none text-slate-100"
        >
          {profileRecord(row.wins, row.losses)}
        </p>
        <div className="text-right">
          <p className="font-mono text-[11px] text-slate-300">
            roster <span data-testid="profile-season-rating">{row.overall.toFixed(1)}</span>
          </p>
          <p data-testid="profile-season-date" className="font-mono text-[11px] text-slate-500">
            {formatDay(row.playedAt)}
          </p>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {row.undefeated ? (
          <span
            data-testid="profile-season-undefeated"
            className="rounded-full bg-[#f5c451] px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-widest text-[#0a1020]"
          >
            Undefeated
          </span>
        ) : null}
        <SourceMarker row={row} />
      </div>

      <ul data-testid="profile-lineup" className="mt-3 divide-y divide-white/5">
        {row.lineup.map((pick, index) => (
          <li
            key={`${pick.slot ?? pick.position}-${pick.name}-${String(index)}`}
            data-testid="profile-lineup-pick"
            className="flex items-center gap-2 py-1.5"
          >
            <span className="grid h-7 w-9 shrink-0 place-items-center rounded-md bg-white/10 font-mono text-[10px] font-bold text-[#f5c451]">
              {pick.slot ?? pick.position}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold leading-tight">{pick.name}</span>
              <span
                data-testid="profile-pick-team-era"
                className="block truncate text-[10px] uppercase tracking-wide text-slate-400"
              >
                {pick.decade} {pick.team}
              </span>
            </span>
            <span className="shrink-0 font-mono text-[11px] font-bold text-slate-200">{pick.rating}</span>
          </li>
        ))}
      </ul>
    </li>
  );
}

/* ------------------------------------------------------------ degradation */

/** Offline is a different sentence from "the board has nowhere to read from". */
function UnreadableProfile({ offline, onRetry }: { offline: boolean; onRetry: () => void }) {
  return (
    <section
      data-testid="profile-board-unavailable"
      data-offline={offline ? "true" : "false"}
      className="rounded-2xl border border-white/10 bg-[#0d1730] p-5"
    >
      <h2 className="text-lg font-black leading-tight">
        {offline ? "You're offline" : "The board can't be read right now"}
      </h2>
      <p className="mt-2 text-sm text-slate-300">
        {offline
          ? "Your seasons are stored on a server as well as on this device, and this phone has no network right now, so the board's side of your profile can't be read. The seasons below are the copies saved in this browser."
          : "The board has nowhere to keep seasons at the moment, so it can't show the ones you posted. Nothing else changes — the seasons below are the copies saved in this browser, and the game plays as usual."}
      </p>
      <button
        type="button"
        onClick={onRetry}
        data-testid="profile-retry"
        className="mt-4 h-11 w-full rounded-xl border border-white/15 text-[11px] font-bold uppercase tracking-widest text-slate-300 transition hover:border-[#f5c451]/60"
      >
        Try again
      </button>
    </section>
  );
}
