/**
 * "Global leaderboard" — the posting panel on the result screen.
 *
 * A player gives a display name once; it is remembered on the device and every
 * completed season after that posts itself, with no submit tap to forget. Both
 * the automatic path and the first-time manual path end in the same
 * confirmation ("on the board as <name> · #N of M"), and there is a small
 * toggle to switch automatic posting off.
 *
 * Deliberately forgiving: the board is a bonus. If the API is unreachable, the
 * database isn't connected, or rate limiting kicks in, the player gets a plain
 * sentence in amber and the run they just played is untouched on the device.
 */
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

import { submitToBoard } from "~/lib/board-api";
import { NAME_MAX, NAME_MIN } from "~/lib/leaderboard";
import type { PlayerStanding } from "~/lib/player-rating";
import {
  ensureDeviceToken,
  loadIdentity,
  loadSubmissions,
  rememberName,
  saveSubmission,
  setPosting,
  type BoardIdentity,
  type BoardSubmission,
  type StoredRun,
} from "~/lib/storage";

interface Notice {
  message: string;
  /** Soft = the board isn't there yet; the run is fine. Amber, not red. */
  soft: boolean;
}

const SOFT_ERRORS = new Set(["not_connected", "offline", "rate_limited"]);

export default function SubmitRun({ run }: { run: StoredRun }) {
  const [identity, setIdentity] = useState<BoardIdentity | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [sending, setSending] = useState(false);
  const [submission, setSubmission] = useState<BoardSubmission | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // The players-board standing this season produced. Server-computed; null when
  // the rating could not be written, which is never an error for the player.
  const [rating, setRating] = useState<PlayerStanding | null>(null);

  // One attempt per mounted run: the automatic path fires once, and a manual
  // tap can never be followed by a surprise second post.
  const attempted = useRef(false);

  // The device remembers the name and the posting choice. Reading it after
  // mount keeps the server-rendered markup identical to the first client pass.
  useEffect(() => {
    attempted.current = false;
    setSubmission(loadSubmissions()[run.id] ?? null);
    const stored = loadIdentity();
    setIdentity(stored);
    setName(stored?.name ?? "");
    setNotice(null);
    setRating(null);
    setLoaded(true);
  }, [run.id]);

  const send = useCallback(
    async (displayName: string): Promise<void> => {
      attempted.current = true;
      const clean = displayName.replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
      if (clean.length < NAME_MIN) {
        setNotice({
          message: `Pick a display name of ${NAME_MIN}–${NAME_MAX} characters.`,
          soft: false,
        });
        return;
      }
      setSending(true);
      setNotice(null);
      const outcome = await submitToBoard({
        name: clean,
        wins: run.wins,
        losses: run.losses,
        undefeated: run.undefeated,
        lineup: run.roster,
        // The identity this season's rating belongs to. The browser makes it on
        // first play; the server only checks its shape.
        deviceToken: ensureDeviceToken(),
      });
      setSending(false);
      if (outcome.ok) {
        const saved: BoardSubmission = {
          runId: run.id,
          name: clean,
          rank: outcome.rank,
          total: outcome.total,
          at: Date.now(),
        };
        saveSubmission(saved);
        // Giving a name once is what turns posting on from here on.
        setIdentity((current) => (current ? current : rememberName(clean, true)));
        setSubmission(saved);
        setRating(outcome.player);
        return;
      }
      setNotice({ message: outcome.message, soft: SOFT_ERRORS.has(outcome.error) });
    },
    [run.id, run.wins, run.losses, run.undefeated, run.roster],
  );

  // Post every completed season automatically, once the device knows a name.
  useEffect(() => {
    if (!loaded || attempted.current || submission) return;
    if (!identity || !identity.posting) return;
    void send(identity.name);
  }, [loaded, identity, submission, send]);

  const togglePosting = (): void => {
    if (!identity) return;
    const next = setPosting(identity, !identity.posting);
    setIdentity(next);
    setNotice(null);
    if (next.posting && !submission) void send(next.name);
  };

  const showForm = loaded && submission === null && (identity === null || !identity.posting || notice?.soft === true);

  return (
    <section
      data-testid="submit-section"
      className="rounded-2xl border border-white/10 bg-[#0d1730] p-4"
    >
      <h3 className="font-mono text-[10px] uppercase tracking-[0.28em] text-slate-400">
        Global leaderboard
      </h3>

      {submission ? (
        <div data-testid="submit-done" className="mt-2 space-y-2">
          <p data-testid="submit-auto" className="text-sm text-slate-200">
            On the board as <span className="font-bold text-[#f5c451]">{submission.name}</span> ·{" "}
            <span className="font-mono text-[12px] text-[#f5c451]">
              #{submission.rank} of {submission.total}
            </span>
          </p>
          <p className="font-mono text-[11px] text-slate-400">
            {submission.rank > 100
              ? "Ranked, outside the top 100 shown"
              : `Every completed season is ranked — this one is #${String(submission.rank)}`}
          </p>
          <div className="flex gap-2">
            <Link
              to="/leaderboard"
              data-testid="submit-board-link"
              className="inline-block h-11 flex-1 rounded-xl border border-white/15 text-center text-[11px] font-bold uppercase leading-[2.75rem] tracking-widest text-slate-300 transition hover:border-[#f5c451]/60"
            >
              See the board
            </Link>
            <Link
              to="/players"
              data-testid="submit-players-link"
              className="inline-block h-11 flex-1 rounded-xl border border-white/15 text-center text-[11px] font-bold uppercase leading-[2.75rem] tracking-widest text-slate-300 transition hover:border-[#f5c451]/60"
            >
              Players board
            </Link>
          </div>
        </div>
      ) : showForm ? (
        <div className="mt-2 space-y-2">
          <p className="text-sm text-slate-300">
            {identity && !identity.posting
              ? "Automatic posting is off, so this run is only on this device."
              : "Put this run on the global board. No account, just a name."}
          </p>
          <label className="block">
            <span className="sr-only">Display name</span>
            <input
              data-testid="submit-name"
              type="text"
              value={name}
              maxLength={NAME_MAX}
              autoComplete="off"
              spellCheck={false}
              placeholder="Display name"
              onChange={(event) => setName(event.target.value)}
              className="h-12 w-full rounded-xl border border-white/15 bg-white/[0.04] px-3 text-sm font-semibold text-slate-100 outline-none placeholder:text-slate-500 focus:border-[#f5c451]/70"
            />
          </label>
          <button
            type="button"
            onClick={() => void send(name)}
            disabled={sending}
            data-testid="submit-run"
            className="h-12 w-full rounded-xl bg-[#f5c451] text-sm font-black uppercase tracking-[0.18em] text-[#0a1020] transition active:scale-[0.99] disabled:opacity-60"
          >
            {sending ? "Adding…" : "Add run to the leaderboard"}
          </button>
          <p data-testid="submit-hint" className="text-[11px] text-slate-500">
            {NAME_MIN}–{NAME_MAX} characters · remember it once and every season posts itself
          </p>
        </div>
      ) : (
        <p data-testid="submit-waiting" className="mt-2 text-sm text-slate-300">
          {sending ? "Posting your run…" : "Every completed season posts itself."}
        </p>
      )}

      {notice ? (
        <p
          data-testid={notice.soft ? "submit-offline" : "submit-error"}
          className={[
            "mt-3 rounded-xl border px-3 py-2 text-[11px] font-semibold",
            notice.soft
              ? "border-[#f5c451]/40 bg-[#f5c451]/10 text-[#f8d98a]"
              : "border-red-500/40 bg-red-500/10 text-red-200",
          ].join(" ")}
        >
          {notice.message}
        </p>
      ) : null}

      {/*
        The player rating this season produced. Rendered only when the server
        sent one back: a missing database leaves the amber notice above, and a
        rating that could not be written simply shows nothing rather than an
        error — the run itself is safe either way.
      */}
      {rating ? (
        <div
          data-testid="submit-rating"
          className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2"
        >
          <div className="flex items-baseline justify-between gap-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-slate-400">
              Player rating
            </p>
            <p className="font-mono text-lg font-black leading-none text-[#f5c451]">
              {rating.rating.toFixed(1)}
            </p>
          </div>
          <p className="mt-1 text-[11px] text-slate-300">
            <span data-testid="submit-tier" className="font-semibold text-slate-100">
              {rating.tier}
            </span>{" "}
            · {rating.seasons} season{rating.seasons === 1 ? "" : "s"} ·{" "}
            {rating.qualified
              ? rating.rank !== null
                ? `#${String(rating.rank)} of the players board`
                : "on the players board"
              : `${String(rating.seasonsToQualify)} more to be ranked`}
          </p>
        </div>
      ) : null}

      {notice?.soft && identity ? (
        <button
          type="button"
          onClick={() => void send(identity.name)}
          disabled={sending}
          data-testid="submit-retry"
          className="mt-2 h-10 w-full rounded-xl border border-white/15 text-[11px] font-bold uppercase tracking-widest text-slate-300 disabled:opacity-60"
        >
          Try posting again
        </button>
      ) : null}

      {loaded && identity ? (
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-white/10 pt-3">
          <p data-testid="posting-state" className="text-[11px] leading-tight text-slate-400">
            Posting every season as{" "}
            <span className="font-semibold text-slate-200">{identity.name}</span> ·{" "}
            {identity.posting ? "on" : "off"}
          </p>
          <button
            type="button"
            role="switch"
            aria-checked={identity.posting}
            onClick={togglePosting}
            data-testid="auto-post-toggle"
            className={[
              "flex h-7 w-14 shrink-0 items-center rounded-full border px-0.5 transition",
              identity.posting
                ? "justify-end border-[#f5c451]/60 bg-[#f5c451]/25"
                : "justify-start border-white/20 bg-white/5",
            ].join(" ")}
            aria-label="Post every completed season automatically"
          >
            <span
              className={[
                "h-5 w-5 rounded-full transition",
                identity.posting ? "bg-[#f5c451]" : "bg-slate-500",
              ].join(" ")}
            />
          </button>
        </div>
      ) : null}
    </section>
  );
}
