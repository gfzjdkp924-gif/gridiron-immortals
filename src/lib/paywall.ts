/**
 * Gridiron Immortals — the money words, in one place.
 *
 * Nothing else in the tree carries a price, a product name or a purchase URL:
 * every screen that mentions money imports from here. That means the price can
 * only ever be wrong in one place, and a string that stops being true changes
 * for the paywall, the board lock notes and `/unlock` together.
 *
 * The rule this module exists to enforce: **the boards are readable by anyone,
 * free.** The unlock buys unlimited runs, posting your seasons, and your player
 * rating — never the ability to look at the leaderboard.
 */

/** Must match the live Stripe product name exactly. */
export const PRODUCT_NAME = "Gridiron Immortals (full game)";

/** One-time price. Never a subscription, on the web or in the stores. */
export const PRICE_LABEL = "$4.99";

/** Live Stripe Payment Link for PRODUCT_NAME. A public URL by design. */
export const BUY_URL = "https://buy.stripe.com/aFacN5cQj4LOa5bdyKdby00";

/**
 * What the unlock actually buys. Deliberately silent about the boards — they
 * are free and visible right next to every one of these panels.
 */
export const UNLOCK_PERKS = [
  "Unlimited runs",
  "Posting your seasons to the global leaderboard",
  "Your player rating",
] as const;

export const UNLOCK_BODY = `One payment of ${PRICE_LABEL}. The unlock adds unlimited runs, posting your seasons to the global leaderboard, and your player rating.`;

export const BUY_LABEL = `Unlock for ${PRICE_LABEL}`;
export const BUY_HINT = "One-time payment by card or Apple Pay. No subscription, no account.";
export const BOARDS_FREE_NOTE =
  "The leaderboard and the players board stay free to read either way.";

/* ------------------------------------------------------- share panel */

/**
 * The share panel's two money-adjacent words, which live here because they are
 * about the purchase: sharing is free on the web precisely because it is NOT
 * what the unlock buys (repeat runs, posting and the rating are).
 */
export const SHARE_BADGE = "Free";
export const SHARE_NOTE =
  "Sharing your own season is free — it is not part of the unlock.";

/* ------------------------------------------------------- paywall (in game) */

/** Shown under the finished result once the device's one free run is spent. */
export const PAYWALL_KICKER = "Free run complete";
export const PAYWALL_TITLE = "Run it back with the full game";
export const PAYWALL_LEAD = `Your first run is free, and it's done. ${UNLOCK_BODY}`;

/* ------------------------------------------------------------ lock notes */

/** One short sentence, two lines at 390px. Must fit under the board state. */
export const BOARD_LOCK_NOTE = `The leaderboard is free to read. Posting your seasons is part of the ${PRICE_LABEL} one-time unlock.`;
export const PLAYERS_LOCK_NOTE = `The players board is free to read. Your player rating is part of the ${PRICE_LABEL} one-time unlock.`;
export const POST_LOCK_NOTE = `This run stays on this device. Posting your seasons to the global leaderboard — and your player rating — come with the ${PRICE_LABEL} unlock.`;

/* ------------------------------------------------- game copy that changed */

/** Home footer: was "every completed season is ranked", which is now false. */
export const GAME_FOOTER = `Runs save on this device. Your first run is free; ${PRICE_LABEL} once adds unlimited runs, posting your seasons and your player rating.`;
/** Home strip under the spin button. */
export const HOME_PRICE_NOTE = `First run free · ${PRICE_LABEL} one-time for the rest`;
/** Home line above the boards: was "every season builds your player rating". */
export const HOME_RATING_NOTE = "Every season you post also builds your player rating.";

/* ------------------------------------------------------------ /unlock page */

export const UNLOCK_PAGE_KICKER = "Gridiron Immortals (full game)";
export const UNLOCK_PAGE_TITLE = "Unlock this device";

export const UNLOCK_NO_PARAM_TITLE = "Nothing to unlock yet";
export const UNLOCK_NO_PARAM_BODY = `This page is where Stripe sends you after buying ${PRODUCT_NAME}. It only unlocks with the checkout link Stripe gives you, which ends in /unlock?session_id=… — open that link, or the one in your receipt email.`;
export const UNLOCK_NO_PARAM_BUY = `Not bought yet? Get it for ${PRICE_LABEL}`;

export const UNLOCK_BAD_PARAM_TITLE = "That link didn't look right";
export const UNLOCK_BAD_PARAM_BODY =
  "The reference in this link isn't a Stripe checkout reference, so nothing was unlocked. Nothing has changed on this device — no charge was made here either way. Open the exact link from your Stripe receipt.";

export const UNLOCK_GRANTED_TITLE = "Unlocked on this device";
export const UNLOCK_GRANTED_BODY = `Unlimited runs, posting your seasons to the global leaderboard and your player rating are on. ${PRODUCT_NAME} was ${PRICE_LABEL} once, charged by Stripe.`;
export const UNLOCK_GRANTED_CAVEAT =
  "Stripe sent your receipt by email — keep it. The unlock is stored in this browser only and can't be checked from the page, so another phone or browser needs its own link from the receipt.";

export const UNLOCK_ALREADY_TITLE = "Already unlocked";
export const UNLOCK_ALREADY_BODY =
  "This browser already has the full game. Nothing to do here.";

export const UNLOCK_BACK = "Back to the game";
