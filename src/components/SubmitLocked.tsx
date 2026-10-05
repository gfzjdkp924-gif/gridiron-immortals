/**
 * What an unpaid player sees where the posting panel would be.
 *
 * It replaces `SubmitRun` outright rather than sitting next to it: an unpaid
 * device must never auto-post a season, so the component that posts is simply
 * not mounted. Nothing here sends anything anywhere.
 */
import {
  BOARDS_FREE_NOTE,
  BUY_LABEL,
  BUY_URL,
  POST_LOCK_NOTE,
} from "~/lib/paywall";

export default function SubmitLocked() {
  return (
    <section
      data-testid="submit-locked"
      className="rounded-2xl border border-[#f5c451]/40 bg-[#f5c451]/10 p-4"
    >
      <h3 className="font-mono text-[10px] uppercase tracking-[0.28em] text-[#f8d98a]">
        Global leaderboard
      </h3>
      <p className="mt-2 text-sm leading-relaxed text-slate-200">{POST_LOCK_NOTE}</p>
      <a
        href={BUY_URL}
        target="_blank"
        rel="noreferrer"
        data-testid="submit-locked-buy"
        className="mt-3 flex h-12 w-full items-center justify-center rounded-xl bg-[#f5c451] text-center text-sm font-black uppercase leading-tight tracking-[0.14em] text-[#0a1020] transition active:scale-[0.99]"
      >
        {BUY_LABEL}
      </a>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-400">{BOARDS_FREE_NOTE}</p>
    </section>
  );
}
