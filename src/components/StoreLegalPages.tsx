/**
 * THE STORE BUILDS' /privacy AND /support PAGES — one component, two editions.
 *
 * Why these two pages exist in a second version at all: the web pages state
 * truths that are only true OF THE WEB GAME — that there is a first free run,
 * that a one-time price is paid on a checkout page, that a receipt's link turns
 * the game back on in a browser. In an app-store download none of that happened
 * (the store took the money before the app was installed), so inside the app
 * those sentences would be false, and a store reviewer reads both pages.
 *
 * AND WHY THERE ARE NOW TWO SETS OF THOSE SENTENCES. There are two store
 * editions, and they differ on exactly one fact: the App Store download is a
 * PAID app, and the Google Play download is a FREE one (the owner's decision,
 * 2026-10-05). So the sentences that name the edition — the "short version" on
 * /privacy, the "no purchase" bullet, "what the game is" and "refunds" on
 * /support, the head description, and the one-line purchase statement that
 * src/lib/legal.ts exposes — come from `~/lib/store-edition-copy`, which
 * vite.config.ts resolves to the file for THIS build's platform. The other
 * edition's copy is not in this bundle at all, and tools/store-build-check.mjs
 * refuses to build a bundle whose wording does not match its own platform.
 *
 * WHAT THESE PAGES ARE ALLOWED TO SAY: exactly what the store build's code does
 * — the device keeps the player's own runs, name and posting choice; a finished
 * season sends one anonymous ping; a posted season sends a display name, record,
 * lineup and device token to the same server the web game uses; there is no
 * account, no cookie, no analytics, no ad, and no payment of any kind inside the
 * app. NOTHING here may name a price, a checkout, a payment processor or a page
 * to unlock on: that is the rule the store build is verified against
 * (tools/store-build-check.mjs), and it is why these strings share nothing with
 * src/lib/paywall.ts.
 *
 * The shared, already-verified sentences (the finished-season count, the posted
 * run and the profile) are reused from src/lib/legal.ts rather than rewritten,
 * so the builds cannot drift apart on facts they both state.
 *
 * src/routes/privacy.tsx and src/routes/support.tsx choose between this file and
 * their web component with `STORE_BUILD` (src/lib/build-flags.ts).
 */
import { Link } from "@tanstack/react-router";

import { Bullets, LegalCard } from "~/components/LegalBlocks";
import SiteFooter from "~/components/SiteFooter";
import {
  AFFILIATION_LINE,
  EFFECTIVE_DATE,
  POSTED_STORAGE_LINE,
  PROFILE_LINE,
  RUN_COUNT_LIMIT_LINE,
  RUN_COUNT_LINE,
  SUPPORT_EMAIL,
  SUPPORT_MAILTO,
} from "~/lib/legal";
import { STORE_EDITION_COPY } from "~/lib/store-edition-copy";

/** Head descriptions, kept next to the pages they describe. */
export const STORE_PRIVACY_DESCRIPTION =
  "What Gridiron Immortals saves on your device, what it sends when you post a season, and how to ask for something to be removed.";
export const STORE_SUPPORT_DESCRIPTION = STORE_EDITION_COPY.supportDescription;

/** The page chrome both documents use, matching the web pages exactly. */
function Shell({
  title,
  testIdPrefix,
  children,
}: {
  title: string;
  testIdPrefix: string;
  children: React.ReactNode;
}) {
  const other = testIdPrefix === "privacy" ? "/support" : "/privacy";
  const otherLabel = testIdPrefix === "privacy" ? "Support" : "Privacy";
  return (
    <div className="min-h-dvh bg-[#070c17] text-slate-100">
      <div className="mx-auto w-full max-w-md px-4 pb-10 pt-5 lg:max-w-2xl lg:px-8">
        <header className="mb-4 flex items-end justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-[#f5c451]">
              Gridiron Immortals
            </p>
            <h1 className="text-xl font-black uppercase leading-none tracking-tight sm:text-2xl">
              {title.split(" ")[0]}{" "}
              <span className="text-[#f5c451]">{title.split(" ").slice(1).join(" ")}</span>
            </h1>
          </div>
          <div className="flex shrink-0 gap-2">
            <Link
              to={other}
              data-testid={`${testIdPrefix}-other-link`}
              className="rounded-full border border-white/15 px-3 py-2 text-[11px] font-bold uppercase tracking-widest text-slate-300 transition hover:border-[#f5c451]/60"
            >
              {otherLabel}
            </Link>
            <Link
              to="/"
              data-testid={`${testIdPrefix}-back`}
              className="rounded-full border border-white/15 px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-slate-300 transition hover:border-[#f5c451]/60 hover:text-slate-100"
            >
              Play
            </Link>
          </div>
        </header>
        <div data-testid={`${testIdPrefix}-page`} className="space-y-4">
          {children}
          <SiteFooter play />
        </div>
      </div>
    </div>
  );
}

export function StorePrivacyPage() {
  return (
    <Shell title="Privacy policy" testIdPrefix="privacy">
      <p data-testid="legal-effective" className="font-mono text-[11px] text-slate-400">
        Effective {EFFECTIVE_DATE}
      </p>

      {/* src/lib/storage.ts — the localStorage keys, minus the two the web build
          keeps for its paywall (there is no entitlement in this build at all:
          src/lib/entitlement.ts) */}
      {/* The edition's own words: a paid app in the App Store download, a free
          one in the Play download (src/lib/store-edition-copy.ts). The tail of
          the paragraph is shared because it is true of both. */}
      <LegalCard title="The short version" testId="privacy-intro">
        <p>
          {STORE_EDITION_COPY.privacyIntroLead}{" "}
          There is nothing in the app that measures you, advertises to you, or follows you to another
          app.
        </p>
        <p>
          Two things leave your device, both about playing and both described in full below: a
          season you post to the leaderboard, and one anonymous request per finished season that
          says nothing but whether it was your first. Everything else stays on the phone.
        </p>
      </LegalCard>

      <LegalCard title="Saved on your device only" testId="privacy-device">
        <Bullets
          items={[
            "Your last 20 finished runs: the wins and losses, whether you went undefeated, the roster rating, and the 11 players you drafted. That is the history the home screen and the profile page show.",
            "The display name you type when you post a run, and whether automatic posting is switched on or off. That switch is the whole opt-out, and it is in the result screen.",
            "A device token: 32 random characters your device makes the first time the game runs on it. It is what the players board credits your rating to. It is not a login, it is not linked to your name or email, and it says nothing about who you are.",
            "The game files themselves, kept inside the app so it plays with no network at all.",
          ]}
        />
        <p>
          None of this is sent anywhere except in the two cases below: posting a season, and the
          finished-season count — and that request carries none of it. Deleting the app removes all
          of it, and the app treats a fresh install as a new device.
        </p>
      </LegalCard>

      <LegalCard title="How many seasons get finished: counted, not tracked" testId="privacy-counters">
        <p data-testid="privacy-counters-note">{RUN_COUNT_LINE}</p>
        <p data-testid="privacy-counters-limit" className="text-slate-400">
          {RUN_COUNT_LIMIT_LINE}
        </p>
      </LegalCard>

      <LegalCard title="What gets posted, and that it is public" testId="privacy-posted">
        <p>
          Posting is optional and it is switched on by giving a name once. When a season finishes
          with posting on — or when you type a name and tap the posting button — the app sends this,
          and only this, to our server: your display name, the record, the 11-man lineup you
          drafted, and your device token.
        </p>
        <Bullets
          items={[
            "Your display name, your record and your lineup are stored and shown to anyone. Both boards are public on purpose.",
            "Your device token is stored against your players-board entry (seasons played, average rating, wins, losses and best record) and against the runs you post, which is what lets your own profile read your own seasons back. The server keeps it only as a one-way hash — the token itself is not stored there — and it is never shown on the board or on a profile.",
            "No email address, no password, no real name, no phone number and no location are sent, because the game never asks for any of them.",
            "The record and the rating that get ranked are worked out again on the server from the lineup, so nothing typed into the app decides your score.",
            "A season you have already posted stays posted even if you switch posting off afterwards.",
          ]}
        />
        <p data-testid="privacy-posted-note" className="text-slate-400">
          {POSTED_STORAGE_LINE} The boards need a connection: with none, the app says the board
          cannot be reached, stores nothing, and your run still saves on the device.
        </p>
        <p data-testid="privacy-profile-note" className="text-slate-400">
          {PROFILE_LINE}
        </p>
      </LegalCard>

      <LegalCard title="The network, and what our server sees" testId="privacy-ip">
        <p>
          The only requests this app makes are to the server that runs the game: reading the two
          boards, posting a season, reading your own profile, and the finished-season count. The
          server counts how many runs one caller posts in a ten-minute window (eight is the limit)
          so nobody can flood the board. Counting needs something to count, so it takes the IP
          address the hosting layer passes along with the request, hashes it with SHA-256 together
          with a fixed internal salt, keeps the first 24 characters of that hash, and counts repeats
          of the hash in the server&rsquo;s memory for ten minutes. The IP address itself is never
          written to a database and never written to a log.
        </p>
        <p className="text-slate-400">
          The finished-season count described above is deliberately not covered by this: its
          endpoint reads no IP address at all, hashes nothing and keeps no key — which is exactly why
          it cannot tell a script from a stranger, as its own note says.
        </p>
      </LegalCard>

      <LegalCard title="No accounts, no cookies, no tracking, no ads" testId="privacy-tracking">
        <Bullets
          strong
          items={[
            "No accounts, no logins, no passwords.",
            "No cookies. What the app saves is the device storage listed above, and it goes nowhere unless you post a season.",
            "No analytics, no tracking pixels, no advertising or social scripts, no third-party fonts and no outside widgets. The app makes no requests to anyone but our own server.",
            STORE_EDITION_COPY.noPurchaseBullet,
            "Nothing is sold, rented or shared with anyone.",
          ]}
        />
        <p data-testid="privacy-hosting-note" className="text-slate-400">
          The platform that serves our server keeps its own standard request logs; that part is not
          ours to read or change. Our own code logs database and store errors only, and never an IP
          address. Nothing of yours is put in a web address either: every use of the device token —
          reading your own profile and your own row on the players board — sends it in the body of a
          request, and never in a URL, so it cannot reach those logs from us.
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
            "Deleting the app does not remove what you already posted: that lives on the board, not on the device.",
          ]}
        />
      </LegalCard>

      <LegalCard title="Changes, and contact" testId="privacy-changes">
        <p>
          These statements change only when the code behind them changes, and the effective date at
          the top moves with them. The game holds no email address, so there is nobody to notify.
          Anything else about privacy, email{" "}
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
    </Shell>
  );
}

export function StoreSupportPage() {
  return (
    <Shell title="Support" testIdPrefix="support">
      <p data-testid="legal-effective" className="font-mono text-[11px] text-slate-400">
        Effective {EFFECTIVE_DATE}
      </p>
      <p className="text-sm leading-relaxed text-slate-300">
        One inbox for everything:{" "}
        <a
          href={SUPPORT_MAILTO}
          data-testid="support-email"
          className="break-all font-semibold text-[#f8d98a] underline decoration-dotted"
        >
          {SUPPORT_EMAIL}
        </a>
      </p>

      <LegalCard title="What the game is" testId="support-what">
        <p>
          Every pick starts with its own spin of a random NFL team and decade. Draft one real player
          from each era the wheel lands on until your 11-man lineup is full, then play the season
          and find out whether your all-time squad can go undefeated.
        </p>
        {/* The edition's own words: "This is the paid app…" in the App Store
            download, "This is the free app…" in the Play download. */}
        <p>{STORE_EDITION_COPY.supportWhatItIs}</p>
      </LegalCard>

      <LegalCard title="Email us" testId="support-contact">
        <p>
          Everything comes to the same address — a bug, a run that looks wrong, a season that did
          not make it onto the board, or a question about a name you posted under. Write to{" "}
          <a href={SUPPORT_MAILTO} className="break-all font-semibold text-[#f8d98a] underline decoration-dotted">
            {SUPPORT_EMAIL}
          </a>
          .
        </p>
        <Bullets
          items={[
            "What you were doing and what happened — spinning, drafting, playing the season, posting a season, or reading a board.",
            "What phone or tablet you are on, and the version of the app.",
            "If it is about the leaderboard: the display name you posted under, and roughly when.",
            "A screenshot helps more than anything else.",
          ]}
        />
      </LegalCard>

      {/* Refunds, in the edition's own words. In the App Store download the sale
          was the store's, so refunds come from the store (see
          /home/team/shared/appstore/metadata.md §2b). In the Play download there
          was no sale at all: the app is free, so the honest answer is that there
          is nothing to refund. */}
      <LegalCard title="Refunds" testId="support-refund">
        <p>{STORE_EDITION_COPY.supportRefundsLead}</p>
        <p>
          If the app will not install, will not open, or will not play, email{" "}
          <a href={SUPPORT_MAILTO} className="break-all font-semibold text-[#f8d98a] underline decoration-dotted">
            {SUPPORT_EMAIL}
          </a>{" "}
          first: that is usually a quicker fix than a refund.
        </p>
      </LegalCard>

      <LegalCard title="Your seasons, the boards, and this device" testId="support-seasons">
        <p>
          Runs are saved on the device that played them and the app works offline, so a run played
          on a plane is there when you land. The two boards are on our server and stay free to read:
          posting a season puts your display name, the record and the 11 players you drafted on the
          leaderboard for anyone to see, and automatic posting can be switched off in the result
          screen.
        </p>
        <Bullets
          items={[
            "Your profile page reads the seasons this device posted and the seasons this device saved, each marked with where it came from. No signup, no password, no email.",
            "There is no account to sign into, which is also why seasons do not follow you to a new phone or tablet: a new install starts with an empty history.",
            "Deleting the app removes your saved runs from the device. What you already posted stays on the board.",
          ]}
        />
      </LegalCard>

      <LegalCard title="Privacy" testId="support-privacy">
        <p>
          What the app keeps, what it sends and what it never collects is on the{" "}
          <Link to="/privacy" className="underline decoration-dotted">
            privacy page
          </Link>
          . In one line: your runs stay on the device, a posted season is public, a finished season
          sends one anonymous count, and there is no account, cookie, analytics or ad anywhere in
          the app.
        </p>
        <p className="text-[11px] text-slate-400">{AFFILIATION_LINE}</p>
      </LegalCard>
    </Shell>
  );
}
