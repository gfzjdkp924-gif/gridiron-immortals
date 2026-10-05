/**
 * THE STORE BUILDS' MONEY WORDS — the app-store counterpart of
 * `src/lib/paywall.ts`.
 *
 * An app-store build is a DOWNLOAD: the money was taken by the store before the
 * app was installed (the App Store edition, a paid download) or was never asked
 * for at all (the Play edition, a free download). Either way inside this bundle
 * there is nothing to sell, nothing to link to, and no price or free-run
 * allowance to quote. `vite.config.ts` swaps `~/lib/paywall` for this file
 * whenever `STORE_BUILD=1`, so every component that asks for a price, a buy link
 * or a paywall sentence gets a value from here instead. The web build never
 * loads this file, and this file never reaches the web build's `dist/`.
 *
 * IT EXPORTS THE SAME NAMES AS THE WEB MODULE, ON PURPOSE. If a component is
 * ever wired up without the swap being checked, it still compiles and still
 * renders honest copy — rather than a web-only price or a checkout link that
 * must not exist in an app-store build. `BUY_URL` is the empty string: there is
 * no purchase URL in this build, and the string is never a link to anywhere.
 *
 * THE TWO SENTENCES THAT NAME THE EDITION — `UNLOCK_BODY` and `GAME_FOOTER` —
 * come from the build's own edition copy (src/lib/store-edition-copy.ts, chosen
 * by vite.config.ts from STORE_PLATFORM), because "the version you bought" is
 * true of the App Store download and false of the free Play one. Everything else
 * here is true of both.
 *
 * The rule for every value below: it may not name a price, a card, a checkout,
 * a payment processor, a free run, or a page to unlock on. The post-build guard
 * (`tools/store-build-check.mjs`) enforces that against the finished `dist/`.
 */
import { STORE_EDITION_COPY } from "~/lib/store-edition-copy";

export const PRODUCT_NAME = "Gridiron Immortals";

/** No price is ever quoted inside an app-store build. */
export const PRICE_LABEL = "";

/** Empty on purpose: an app-store download has no purchase URL. */
export const BUY_URL = "";

/**
 * What a run includes in this build. The same three things the web build
 * charges for — here they arrived with the download.
 */
export const UNLOCK_PERKS = [
  "Unlimited runs",
  "Posting your seasons to the global leaderboard",
  "Your player rating",
] as const;

export const UNLOCK_BODY = STORE_EDITION_COPY.unlockBody;

/** No button, no label: nothing in this build sells anything. */
export const BUY_LABEL = "";
export const BUY_HINT = "";

export const BOARDS_FREE_NOTE = "The leaderboard and the players board are free to read.";

/* ------------------------------------------------------- share panel */

/** Nothing in this app is gated, so the share panel claims nothing. */
export const SHARE_BADGE = "Share";
export const SHARE_NOTE =
  "Sharing your own season is included — send the card to anyone.";

/* ------------------------------------------------------- paywall (in game) */

/**
 * The paywall panel is never rendered in this build (there is no gate to hit),
 * so these are empty strings rather than sentences. If a future change ever
 * mounted the panel here by mistake, it would render nothing instead of a price.
 */
export const PAYWALL_KICKER = "";
export const PAYWALL_TITLE = "";
export const PAYWALL_LEAD = "";

/* ------------------------------------------------------------ lock notes */

/**
 * The boards' "read this free, post to it with the purchase" notes. Nothing in
 * this build is gated, so these are only reached if a board is genuinely
 * unreachable — hence the plain sentences.
 */
export const BOARD_LOCK_NOTE = "The leaderboard is free to read.";
export const PLAYERS_LOCK_NOTE = "The players board is free to read.";
export const POST_LOCK_NOTE = "This run stays on this device.";

/* ------------------------------------------------- game copy that changed */

/** Home footer. The web wording quotes a price and a free first run — neither may appear here. */
export const GAME_FOOTER = STORE_EDITION_COPY.gameFooter;
/** Home strip under the spin button. */
export const HOME_PRICE_NOTE = "Every run is included — there is nothing else to buy.";
/** Home line above the boards: true in both builds. */
export const HOME_RATING_NOTE = "Every season you post also builds your player rating.";

/* ------------------------------------------------ the /unlock page strings */

/**
 * `/unlock` does not exist in this build (the route file is excluded from the
 * route tree — see vite.config.ts), so nothing renders these. They are defined
 * only so this module keeps the web module's export surface.
 */
export const UNLOCK_PAGE_KICKER = PRODUCT_NAME;
export const UNLOCK_PAGE_TITLE = "";
export const UNLOCK_NO_PARAM_TITLE = "";
export const UNLOCK_NO_PARAM_BODY = "";
export const UNLOCK_NO_PARAM_BUY = "";
export const UNLOCK_BAD_PARAM_TITLE = "";
export const UNLOCK_BAD_PARAM_BODY = "";
export const UNLOCK_GRANTED_TITLE = "";
export const UNLOCK_GRANTED_BODY = "";
export const UNLOCK_GRANTED_CAVEAT = "";
export const UNLOCK_ALREADY_TITLE = "";
export const UNLOCK_ALREADY_BODY = "";
export const UNLOCK_BACK = "Back to the game";
