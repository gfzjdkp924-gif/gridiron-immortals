/**
 * `/support` — where a player goes when something is wrong, or when they want
 * their money back.
 *
 * The facts on this page are the shipped ones: the price and the product come
 * from src/lib/paywall.ts, the unlock-is-per-browser behaviour from
 * src/lib/entitlement.ts and src/routes/unlock.tsx, the "no delete button" from
 * the absence of any delete path in src/ (the boards are written by
 * src/server/leaderboard.ts and read-only in the UI), and the board's connected
 * state is whatever /api/leaderboard reports.
 */
import { Link, createFileRoute } from "@tanstack/react-router";

import { Bullets, LegalCard } from "~/components/LegalBlocks";
import SiteFooter from "~/components/SiteFooter";
import { STORE_SUPPORT_DESCRIPTION, StoreSupportPage } from "~/components/StoreLegalPages";
import { STORE_BUILD } from "~/lib/build-flags";
import {
  POSTED_STORAGE_LINE,
  PROFILE_LINE,
  PRICE_LABEL,
  PURCHASE_LINE,
  RUN_COUNT_LIMIT_LINE,
  RUN_COUNT_LINE,
  SUPPORT_EMAIL,
  SUPPORT_MAILTO,
} from "~/lib/legal";

export const Route = createFileRoute("/support")({
  head: () => ({
    meta: [
      { title: "Support — Gridiron Immortals" },
      {
        name: "description",
        content: STORE_BUILD
          ? STORE_SUPPORT_DESCRIPTION
          : "How to reach Gridiron Immortals: what to include when reporting a problem, how refunds work, and which browser your $4.99 unlock lives in.",
      },
    ],
  }),
  // The paid app-store build owes the store a support page whose refund,
  // posting and season-storage statements are true of the app: it gets its own
  // document (see the header of src/components/StoreLegalPages.tsx).
  component: STORE_BUILD ? StoreSupportPage : SupportPage,
});

function SupportPage() {
  return (
    <div className="min-h-dvh bg-[#070c17] text-slate-100">
      <div className="mx-auto w-full max-w-md px-4 pb-10 pt-5 lg:max-w-2xl lg:px-8">
        <header className="mb-4 flex items-end justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-[#f5c451]">
              Gridiron Immortals
            </p>
            <h1 className="text-xl font-black uppercase leading-none tracking-tight sm:text-2xl">
              Support
            </h1>
          </div>
          <div className="flex shrink-0 gap-2">
            <Link
              to="/privacy"
              data-testid="support-privacy-link"
              className="rounded-full border border-white/15 px-3 py-2 text-[11px] font-bold uppercase tracking-widest text-slate-300 transition hover:border-[#f5c451]/60"
            >
              Privacy
            </Link>
            <Link
              to="/"
              data-testid="support-back"
              className="rounded-full border border-white/15 px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-slate-300 transition hover:border-[#f5c451]/60 hover:text-slate-100"
            >
              Play
            </Link>
          </div>
        </header>

        <div data-testid="support-page" className="space-y-4">
          <LegalCard title="What the game is" testId="support-what">
            <p>
              Every pick starts with its own spin of a random NFL team and decade, and you draft one
              real player from that team's era into each of the 11 positions, so the finished lineup
              mixes eras. Then play a 17-game season and find out whether your all-time squad goes
              undefeated. It runs in a phone browser, and the first run on a browser is free.
            </p>
            <p>
              {PRICE_LABEL} once unlocks unlimited runs, posting your seasons to the global
              leaderboard, and your player rating. Never a subscription, never an account.
            </p>
          </LegalCard>

          <LegalCard title="Email us" testId="support-contact">
            <p>
              Everything — a bug, a run that looks wrong, a refund, an unlock that did not take, a
              request to remove something you posted — goes to one address, read by a person:
            </p>
            <p>
              <a
                href={SUPPORT_MAILTO}
                data-testid="support-email"
                className="break-all text-sm font-semibold text-[#f8d98a] underline decoration-dotted"
              >
                {SUPPORT_EMAIL}
              </a>
            </p>
            <p className="text-slate-400">
              There is no ticket number, no login to the game to check and no dashboard behind this
              page. A plain email reaches the person who can actually fix it.
            </p>
          </LegalCard>

          <LegalCard title="Reporting a problem: what to include" testId="support-report">
            <Bullets
              items={[
                "What you were doing and what happened — spinning, drafting, playing the season, posting a run, reading a board, or unlocking the full game.",
                "Your device and browser, roughly: for example an iPhone with Safari, or an Android phone with Chrome.",
                "If it is about something posted to the board: the display name you posted under and about when.",
                "If it is about the unlock: about when you paid, and the address Stripe sent the receipt to.",
                "A screenshot if you have one — it usually saves a round trip.",
              ]}
            />
          </LegalCard>

          {/* src/lib/paywall.ts (BUY_URL, PRICE_LABEL) + src/lib/legal.ts */}
          <LegalCard title="Refunds" testId="support-refunds">
            <p>{PURCHASE_LINE}</p>
            <p>
              If you want your money back, ask: email{" "}
              <a
                href={SUPPORT_MAILTO}
                className="break-all font-semibold text-[#f8d98a] underline decoration-dotted"
              >
                {SUPPORT_EMAIL}
              </a>{" "}
              with about when you paid, and we will refund the charge through Stripe.
            </p>
            <p>
              There is no refund button in the game and no payment dashboard to send you to — the
              card charge is Stripe&rsquo;s, the decision is ours, and the confirmation comes from
              Stripe when the refund is done. Nothing is hidden behind this: the price is{" "}
              {PRICE_LABEL}, it is charged once, and there is nothing recurring to cancel.
            </p>
          </LegalCard>

          {/* src/lib/entitlement.ts, src/routes/unlock.tsx */}
          <LegalCard title="Which browser your unlock is on" testId="support-unlock">
            <p>
              Your purchase turns the full game on in the browser you bought it in. A different
              phone, or a different browser on the same phone, is not unlocked by the same purchase:
              it needs its own purchase, or the unlock link from your Stripe receipt opened in that
              browser.
            </p>
            <p>
              Keep the receipt. Because the unlock lives in the browser rather than in an account,
              clearing your browser&rsquo;s site data clears the unlock too — reopening the
              receipt&rsquo;s link puts it back. That is also why there is no way for us to check an
              unlock for you: we have nothing on our side to check it against.
            </p>
          </LegalCard>

          <LegalCard title="Known limits, stated plainly" testId="support-limits">
            <p className="text-slate-300">{POSTED_STORAGE_LINE}</p>
            {/* src/routes/profile.tsx — what /profile does and does not promise. */}
            <p data-testid="support-profile-note" className="text-slate-300">
              {PROFILE_LINE}
            </p>
            <Bullets
              items={[
                "The boards store what you post on the server that runs the game. If that storage cannot be written, the board pages say so and a posted run stores nothing — the run itself still saves on your device.",
                "There is no delete button for a run already posted, and no way to edit one. Email us and it is removed by hand.",
                "There is no account, so nothing can be recovered from us: clearing site data makes the browser look new to the game, and you will need the receipt's unlock link to put the unlock back.",
                "Display names are not unique and not reserved — they are 3–16 characters and two players can pick the same one. The board has no accounts, so it cannot promise more than that.",
              ]}
            />
          </LegalCard>

          {/* src/lib/run-count.ts, src/routes/api/run-count.ts,
              src/lib/run-stats.ts, GET /api/stats — the count and its limit,
              stated here as well as on /privacy because it is the one thing the
              game measures about play. */}
          <LegalCard title="Does anyone actually play? What the game counts" testId="support-counters">
            <p data-testid="support-counters-note">{RUN_COUNT_LINE}</p>
            <p data-testid="support-counters-limit" className="text-slate-400">
              {RUN_COUNT_LIMIT_LINE}
            </p>
            <p className="text-slate-400">
              The full statement is on the{" "}
              <Link to="/privacy" className="underline decoration-dotted">
                privacy page
              </Link>
              .
            </p>
          </LegalCard>

          <LegalCard title="Free to read, free to try" testId="support-free">
            <Bullets
              items={[
                `The leaderboard and the players board are free to read, with no purchase and no account.`,
                "The first run on a browser is free: spin before each pick, draft all 11, play the season and see the result.",
                `${PRICE_LABEL} once adds unlimited runs, posting your seasons, and your player rating.`,
                "Posting is optional and can be switched off in the result screen; the boards keep working either way.",
              ]}
            />
          </LegalCard>

          <SiteFooter play />
        </div>
      </div>
    </div>
  );
}
