/**
 * Gridiron Immortals — the legal facts, in one place.
 *
 * `/privacy` and `/support` are written from the code that ships, and every
 * fact on them that also lives elsewhere in the tree is imported from here (or
 * from `paywall.ts`), so a page cannot drift away from the build. What each
 * constant is checked against:
 *
 *   SUPPORT_EMAIL    the owner's public address: support, refunds and any
 *                    privacy/removal request all land in one inbox.
 *   EFFECTIVE_DATE   the day this revision of /privacy took effect. Move it
 *                    whenever a statement on the page changes.
 *   AFFILIATION_LINE  true by construction: we hold no NFL licence or approval.
 *   PRICE_LABEL / PRODUCT_NAME  re-exported from src/lib/paywall.ts, so the
 *                    price and the product can only ever be wrong in one place.
 *
 * The rules those pages follow, so a later edit keeps them true:
 *
 *  - On-device storage: src/lib/storage.ts (runs, posted-run record, display
 *    name + posting switch, device token) and src/lib/entitlement.ts (the paid
 *    unlock, the free-run flag). All of it is localStorage, plus the service
 *    worker's caches in public/sw.js. No cookies anywhere in src/.
 *  - What is sent and stored: src/components/SubmitRun.tsx and
 *    src/lib/board-api.ts send { name, wins, losses, undefeated, lineup,
 *    deviceToken }; src/lib/leaderboard-sql.ts (gridiron_runs) and
 *    src/lib/players-sql.ts (gridiron_players) are the tables it lands in. The
 *    board shows the name, record and lineup publicly; the device token is
 *    hashed by src/server/player-key.ts before either store sees it, so what is
 *    stored on the players board is a one-way key, and it is never rendered (see
 *    mapStandingRow in src/lib/player-rating.ts).
 *  - Where the board's copy lives: src/server/file-store.ts keeps it in the
 *    site's own `.data` directory, which is shipped with every publish, so a
 *    posted run is carried forward with each update of the game. POSTED_STORAGE_LINE
 *    below is the sentence on /privacy and /support that has to stay true to it.
 *  - The caller's IP is hashed, not stored: callerKey() in
 *    src/server/leaderboard.ts. That is the POST path only, for posting a run —
 *    the finished-season count deliberately reads NO IP address at all
 *    (src/routes/api/run-count.ts), because the count's whole value is that it
 *    identifies nobody.
 *  - The finished-season count: what the client sends is src/lib/run-count.ts
 *    (`{ first: boolean }`, one field), what is stored is src/lib/run-stats.ts
 *    (four numbers plus a 30-day tally, inside the board document), and the
 *    endpoints are POST /api/run-count and GET /api/stats. RUN_COUNT_LINE and
 *    RUN_COUNT_LIMIT_LINE below must stay true to all of it — and must never
 *    claim more protection for that number than an anonymous counter can have.
 *  - Payment is Stripe's hosted checkout (BUY_URL in src/lib/paywall.ts); we
 *    hold no Stripe key, so no card data and no verification of a payment ever
 *    reaches our server.
 *  - Never claim more than this: no "we collect nothing" (we store what is
 *    posted), no deletion tool we do not have, and no "verified purchase"
 *    language (see the honest limits at the top of src/lib/entitlement.ts).
 */
import { PRICE_LABEL, PRODUCT_NAME } from "~/lib/paywall";
import { STORE_BUILD } from "~/lib/build-flags";
import { STORE_EDITION_COPY } from "~/lib/store-edition-copy";

export { PRICE_LABEL, PRODUCT_NAME };

/** Support, refunds and every privacy request land in this one inbox. */
export const SUPPORT_EMAIL = "gridiron-immortals-976293e6@ctomail.io";
export const SUPPORT_MAILTO = `mailto:${SUPPORT_EMAIL}`;

/** The date /privacy took effect. Move it when the statements change. */
export const EFFECTIVE_DATE = "4 October 2026";

/**
 * One sentence, on every footer: the game uses real names for historical
 * reference and has no relationship with the league or its clubs.
 */
export const AFFILIATION_LINE =
  "Gridiron Immortals is not affiliated with, endorsed by, or sponsored by the NFL or any of its clubs; real team and player names are used for historical reference only.";

/**
 * The purchase, stated once so /privacy and /support agree on it.
 *
 * In a store build the money was handled by the store before the app was
 * installed (App Store edition, a paid download) or was never asked for at all
 * (Play edition, a free download) — and the two are not interchangeable, so the
 * sentence comes from the build's own edition copy
 * (src/lib/store-edition-copy.ts, chosen by vite.config.ts from STORE_PLATFORM).
 * This is the version to use if a shared sentence ever needs it; the store pages
 * themselves say the same thing in their own words
 * (src/components/StoreLegalPages.tsx).
 */
export const PURCHASE_LINE = STORE_BUILD
  ? STORE_EDITION_COPY.purchaseLine
  : `${PRODUCT_NAME} is a one-time purchase of ${PRICE_LABEL} — not a subscription. There is nothing recurring to cancel and no account to close.`;

/**
 * WHERE A POSTED RUN IS KEPT — one sentence, used by /privacy and /support, so
 * the pages cannot drift from the code.
 *
 * With no database connected the two boards are stored in a file on the server
 * that runs the game (src/server/file-store.ts); when a database IS connected,
 * the same fields go into its two tables (src/lib/leaderboard-sql.ts,
 * src/lib/players-sql.ts). Either way it is our server and never the device,
 * and either way "not connected" means that storage could not be written — the
 * boards' own wording now says exactly that.
 *
 * The second half of the sentence has to stay true now that /profile exists
 * (src/routes/profile.tsx): the BOARD's copy is the server's, while the device
 * keeps its own copy of every run it plays, posted or not — which is precisely
 * what the profile page puts side by side, each marked with where it came from.
 */
export const POSTED_STORAGE_LINE =
  "A posted run is kept on the server that runs the game, in the board's own storage there, alongside every other posted run — and that storage is carried forward each time the game is updated, so a posted season outlives an update. The board's copy is not kept on your device: your device keeps its own copy of every season you play, posted or not, and the profile page shows both, each one marked with where it came from. Reading either board needs no purchase and no account.";

/**
 * THE PROFILE, STATED ONCE — used by /privacy and /support.
 *
 * Every clause is checked against the code:
 *   - two sources merged, de-duplicated, and marked: src/lib/profile.ts
 *     (`mergeProfileSeasons`, `SeasonSource`).
 *   - matched to a device by the one-way key of its token, never by the display
 *     name: src/server/player-key.ts, `gridiron_runs.player_key`
 *     (src/lib/leaderboard-sql.ts), `fileReadPlayerSeasons`
 *     (src/server/file-board.ts).
 *   - no signup, no password, no email: the page reads `ensureDeviceToken()` and
 *     the device's own runs out of localStorage (src/lib/storage.ts) and sends
 *     nothing else; `POST /api/profile` takes a token in the body (never in the
 *     URL — see src/routes/api/profile.ts) and writes nothing.
 *   - cannot follow a player to a new phone: the token lives in localStorage, so
 *     clearing site data starts a fresh identity — the same limit /privacy
 *     already states for the unlock.
 */
export const PROFILE_LINE =
  "Your profile page reads two things and shows them together: the seasons this device posted to the board, read back from the server, and the seasons this device saved itself, clearly marked as not posted. A season is matched to a device by a one-way key made from that device's own token, never by the display name — two players who pick the same name stay two players, and a profile can only ever be its own device's. A profile asks for no signup, no password and no email, which is also why it cannot follow you to a new phone.";

/**
 * THE FINISHED-SEASON COUNT, STATED ONCE — used by /privacy and /support.
 *
 * Every clause is checked against the code:
 *   - what is sent: src/lib/run-count.ts sends `{ first: boolean }` to
 *     POST /api/run-count and nothing else; there is no device token, cookie,
 *     name or id in the request, and the server reads no IP address on that path
 *     (src/routes/api/run-count.ts says so in as many words).
 *   - what is stored: src/lib/run-stats.ts — runsFinished, firstRuns, byDay and
 *     firstByDay, per UTC day, last 30 days. Numbers only.
 *   - when it is sent: at the finish of every season, whether or not the device
 *     has paid and whether or not posting is switched on, fired without being
 *     awaited AFTER the run is saved on the device (src/components/Game.tsx).
 *   - what it cannot do: identify anyone. Two players with three finished
 *     seasons each are six, and we cannot tell them apart.
 *   - the `first` flag comes from the device's own storage (the free-run flag and
 *     the saved-run history) and is the only thing that moves `firstRuns`.
 */
export const RUN_COUNT_LINE =
  "When a season finishes, the game sends one small request to our server, and it carries a single true or false: whether that was the first season this browser had ever finished. The server adds one to a running count of finished seasons, one to the count of first seasons, and one to that day's tally, keeping the last 30 days. Nothing else goes with it — no name, no device token, no cookie, no id of any kind, and no IP address is read or stored on that path — and nothing about the run itself: the roster, the record and the team are not sent. The numbers say how many seasons have been finished and never who played them. It is sent for every finished season, whether or not you have paid and whether or not posting is switched on, and if it cannot be sent nothing happens at all: your season still finishes and still saves on your device. It is the one number we keep about play, and it exists because a finished season used to leave no trace we could see.";

/**
 * The count's honest limit, next to the count itself. The endpoint takes no
 * identifier, so it cannot tell one caller from another — which means it cannot
 * really stop anyone determined to inflate it. Said plainly rather than implied
 * away: the mitigation is a shape check plus a small per-minute ceiling
 * (src/routes/api/run-count.ts), not a person.
 */
export const RUN_COUNT_LIMIT_LINE =
  "The count is anonymous, and that has a cost worth stating: because the request carries nothing that identifies the caller, anybody who wants to could send it repeatedly and inflate the number. The server refuses anything that is not exactly this one field, and drops bursts past a small per-minute ceiling, but it cannot tell a script from a stranger — that would take the identifying data this count deliberately does not have. Treat the number as a rough sign of whether anyone is playing, not as a fact worth arguing about.";
