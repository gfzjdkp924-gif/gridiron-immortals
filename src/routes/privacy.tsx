/**
 * `/privacy` — the privacy policy, written from the code that ships.
 *
 * Every statement below is traceable to a file, and the comments in this one say
 * which: read them next to the text. The rule this page follows is that it may
 * be *less* than the code does, never more — there is no "we collect nothing",
 * no deletion tool we do not have, and no claim that a purchase is verified.
 * See src/lib/legal.ts for the shared facts and the full list of rules.
 */
import { Link, createFileRoute } from "@tanstack/react-router";

import { Bullets, LegalCard } from "~/components/LegalBlocks";
import SiteFooter from "~/components/SiteFooter";
import { STORE_PRIVACY_DESCRIPTION, StorePrivacyPage } from "~/components/StoreLegalPages";
import { STORE_BUILD } from "~/lib/build-flags";
import {
  AFFILIATION_LINE,
  EFFECTIVE_DATE,
  POSTED_STORAGE_LINE,
  PROFILE_LINE,
  PRICE_LABEL,
  RUN_COUNT_LIMIT_LINE,
  RUN_COUNT_LINE,
  SUPPORT_EMAIL,
  SUPPORT_MAILTO,
} from "~/lib/legal";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy policy — Gridiron Immortals" },
      {
        name: "description",
        content: STORE_BUILD
          ? STORE_PRIVACY_DESCRIPTION
          : "What Gridiron Immortals saves on your device, what it sends when you post a run, why the payment goes through Stripe, and how to ask for something to be removed.",
      },
    ],
  }),
  // The paid app-store build has no checkout, no free run and no price, so the
  // web text would be false there: it gets its own document (see the header of
  // src/components/StoreLegalPages.tsx).
  component: STORE_BUILD ? StorePrivacyPage : PrivacyPage,
});

function PrivacyPage() {
  return (
    <div className="min-h-dvh bg-[#070c17] text-slate-100">
      <div className="mx-auto w-full max-w-md px-4 pb-10 pt-5 lg:max-w-2xl lg:px-8">
        <header className="mb-4 flex items-end justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-[#f5c451]">
              Gridiron Immortals
            </p>
            <h1 className="text-xl font-black uppercase leading-none tracking-tight sm:text-2xl">
              Privacy <span className="text-[#f5c451]">policy</span>
            </h1>
          </div>
          <div className="flex shrink-0 gap-2">
            <Link
              to="/support"
              data-testid="privacy-support-link"
              className="rounded-full border border-white/15 px-3 py-2 text-[11px] font-bold uppercase tracking-widest text-slate-300 transition hover:border-[#f5c451]/60"
            >
              Support
            </Link>
            <Link
              to="/"
              data-testid="privacy-back"
              className="rounded-full border border-white/15 px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-slate-300 transition hover:border-[#f5c451]/60 hover:text-slate-100"
            >
              Play
            </Link>
          </div>
        </header>

        <div data-testid="privacy-page" className="space-y-4">
          <p data-testid="legal-effective" className="font-mono text-[11px] text-slate-400">
            Effective {EFFECTIVE_DATE}
          </p>

          <LegalCard title="The short version" testId="privacy-intro">
            <p>
              Gridiron Immortals is a phone browser game with a one-time {PRICE_LABEL} purchase.
              There are no accounts and no logins. What follows is the whole of it: everything the
              game keeps, everything it sends, and what you can ask us to take back. It was written
              from the code that runs the game, not from a template — so if something is not on this
              page, the game does not do it.
            </p>
          </LegalCard>

          {/* src/lib/storage.ts, src/lib/entitlement.ts, public/sw.js */}
          <LegalCard title="Saved on your device only" testId="privacy-device">
            <Bullets
              items={[
                "Your last 20 finished runs: the wins and losses, whether you went undefeated, the roster rating, and the 11 players you drafted. That is the history the home screen shows.",
                "The display name you type when you post a run, and whether automatic posting is switched on or off. That switch is the whole opt-out, and it is in the result screen.",
                "A device token: 32 random characters your browser makes the first time the game runs on it. It is what the players board credits your rating to. It is not a login, it is not linked to your name or email, and it says nothing about who you are.",
                "Whether this browser has the paid unlock, when it unlocked, and the checkout reference it unlocked with.",
                "A flag recording that this browser has finished its one free run.",
                "The game files themselves, kept by the browser and a service worker so the game still plays with no network.",
              ]}
            />
            <p>
              None of this is sent anywhere except in two cases: posting a run, and the
              finished-season count described below — and that request carries none of it.
              Clearing your browser&rsquo;s site data (&ldquo;Clear browsing data&rdquo; /
              &ldquo;Clear website data&rdquo;) removes all of it, including the unlock and
              the free-run flag — after that, the game treats this browser as a new device. If
              you clear the unlock by accident, the unlock link in your Stripe receipt turns it
              back on in whichever browser you open it in.
            </p>
          </LegalCard>

          {/* src/lib/run-count.ts (the client sends one boolean),
              src/routes/api/run-count.ts (the endpoint, which reads no IP),
              src/lib/run-stats.ts + src/server/file-store.ts (the numbers, in
              the board document), GET /api/stats (the readout) */}
          <LegalCard title="How many seasons get finished: counted, not tracked" testId="privacy-counters">
            <p data-testid="privacy-counters-note">{RUN_COUNT_LINE}</p>
            <p data-testid="privacy-counters-limit" className="text-slate-400">
              {RUN_COUNT_LIMIT_LINE}
            </p>
          </LegalCard>

          {/* src/components/SubmitRun.tsx, src/lib/board-api.ts,
              src/lib/leaderboard-sql.ts, src/lib/players-sql.ts,
              src/server/player-key.ts (the device token is hashed before any
              store sees it), src/server/file-store.ts (the store used while no
              database is connected) */}
          <LegalCard title="What gets posted, and that it is public" testId="privacy-posted">
            <p>
              Posting is optional. When a season finishes and posting is on — or when you type a name
              and tap &ldquo;Add run to the leaderboard&rdquo; — the browser sends this, and only
              this, to our server: your display name, the record, the 11-man lineup you drafted, and
              your device token.
            </p>
            <Bullets
              items={[
                "Your display name, your record and your lineup are stored and shown to anyone. Both boards are public and free to read, on purpose — they are the best advertisement this game has.",
                "Your device token is stored against your players-board entry (seasons played, average rating, wins, losses and best record) and against the runs you post, which is what lets your own profile read your own seasons back. The server keeps it only as a one-way hash — the token itself is not stored there — and it is never shown on the board or on a profile.",
                "No email address, no password, no real name, no phone number and no location are sent, because the game never asks for any of them.",
                "The record and the rating that get ranked are worked out again on the server from the lineup, so nothing typed into the browser decides your score.",
                "A season you have already posted stays posted even if you switch posting off afterwards.",
              ]}
            />
            <p data-testid="privacy-posted-note" className="text-slate-400">
              {POSTED_STORAGE_LINE} If the board&rsquo;s storage cannot be written at all, the
              board pages say so and a posted run stores nothing.
            </p>
            {/* src/routes/profile.tsx, src/lib/profile.ts, POST /api/profile */}
            <p data-testid="privacy-profile-note" className="text-slate-400">
              {PROFILE_LINE}
            </p>
          </LegalCard>

          {/* callerKey() in src/server/leaderboard.ts */}
          <LegalCard title="Your IP address: hashed, never stored" testId="privacy-ip">
            <p>
              The server counts how many runs one caller posts in a ten-minute window (eight is the
              limit) so nobody can flood the board. Counting needs something to count, so it takes
              the IP address the hosting layer passes along with the request, hashes it with SHA-256
              together with a fixed internal salt, keeps the first 24 characters of that hash, and
              counts repeats of the hash in the server&rsquo;s memory for ten minutes. The IP address
              itself is never written to the database and never written to a log.
            </p>
            <p className="text-slate-400">
              The finished-season count described above is deliberately not covered by this: its
              endpoint reads no IP address at all, hashes nothing and keeps no key — which is exactly
              why it cannot tell a script from a stranger, as its own note says.
            </p>
          </LegalCard>

          {/* BUY_URL in src/lib/paywall.ts; /unlock in src/routes/unlock.tsx */}
          <LegalCard title="Payment goes through Stripe" testId="privacy-payment">
            <p>
              The {PRICE_LABEL} is paid on Stripe&rsquo;s own checkout page, which the buy button
              opens. Your card details go to Stripe and never reach our server: we hold no Stripe
              key, so we cannot look up a payment, charge a card or check that a purchase was real.
              What the game receives is the checkout reference Stripe sends back, and the page that
              unlocks the game only checks the shape of that reference — it is a claim, not a
              verification. Stripe&rsquo;s own privacy policy covers what Stripe collects.
            </p>
            <p>
              The sale is direct from us rather than through an app store, so refunds are ours to
              give: see the <Link to="/support" className="underline decoration-dotted">support page</Link>.
            </p>
          </LegalCard>

          {/* No analytics/tracking/cookies anywhere in src/; the built client
              bundle's only outside URL is buy.stripe.com (verified by grepping
              dist/client/assets). */}
          <LegalCard title="No accounts, no cookies, no tracking, no ads" testId="privacy-tracking">
            <Bullets
              items={[
                "No accounts, no logins, no passwords.",
                "No cookies. What the game saves is browser storage, listed above, and it goes nowhere unless you post a run.",
                "No analytics, no tracking pixels, no advertising or social scripts, no third-party fonts and no outside widgets. The pages make no requests to anyone but this site — the one exception is Stripe's checkout, and only when you tap buy.",
                "Nothing is sold, rented or shared with anyone.",
              ]}
              strong
            />
            <p data-testid="privacy-hosting-note" className="text-slate-400">
              The platform that serves this site keeps its own standard request logs; that part is
              not ours to read or change. Our own code logs database and store errors only, and never
              an IP address. Nothing of yours is put in a web address either: every use of the
              device token — reading your own profile and your own row on the players board — sends
              it in the body of a request, and never in a URL, so it cannot reach those logs from
              us. There is no analytics here and nothing about your visit is measured:
              the only number the game keeps about play is the finished-season count above, which
              has no visitor attached to it.
            </p>
          </LegalCard>

          <LegalCard title="Asking us to remove something" testId="privacy-removal">
            <p>
              To have a posted run or a players-board entry removed, email{" "}
              <a
                href={SUPPORT_MAILTO}
                data-testid="privacy-email"
                className="break-all font-semibold text-[#f8d98a] underline decoration-dotted"
              >
                {SUPPORT_EMAIL}
              </a>{" "}
              with the display name you posted under and roughly when you posted it.
            </p>
            <Bullets
              items={[
                "There is no delete button in the game yet, so removals are done by hand from that email. The board stores no email addresses and has no accounts, so the display name and the date are the only way to find your entry.",
                "We cannot prove who is behind a display name — anyone could ask us to remove anyone's entry. That is the cost of having no accounts, and we would rather say so than pretend otherwise.",
                "Clearing your browser's site data does not remove what you already posted: that lives on the board, not on the device.",
              ]}
            />
          </LegalCard>

          <LegalCard title="Changes, and contact" testId="privacy-changes">
            <p>
              These statements change only when the code behind them changes, and the effective date
              at the top moves with them. The game holds no email address, so there is nobody to
              notify. Anything else about privacy, email{" "}
              <a
                href={SUPPORT_MAILTO}
                className="break-all font-semibold text-[#f8d98a] underline decoration-dotted"
              >
                {SUPPORT_EMAIL}
              </a>
              .
            </p>
            <p className="text-[11px] text-slate-400">{AFFILIATION_LINE}</p>
          </LegalCard>

          <SiteFooter play />
        </div>
      </div>
    </div>
  );
}
