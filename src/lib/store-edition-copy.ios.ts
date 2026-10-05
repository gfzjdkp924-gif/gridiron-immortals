/**
 * WHAT AN APP-STORE BUILD SAYS ABOUT ITS OWN EDITION — the App Store (paid) set.
 *
 * THERE ARE TWO STORE EDITIONS NOW, AND THEY ARE NOT THE SAME PRODUCT IN ONE
 * RESPECT: the App Store download is a PAID app (the store took one payment
 * before it was installed), and the Google Play download is a FREE app (there is
 * no price, no purchase, nothing to unlock and nothing to buy — the owner's
 * decision, 2026-10-05, and a one-way one: Google's rule is "Once your app has
 * been offered for free, the app can't be changed to paid",
 * https://support.google.com/googleplay/android-developer/answer/6334373).
 *
 * So every sentence that names the edition lives here and in
 * `store-edition-copy.android.ts`, and nowhere else. `vite.config.ts` resolves
 * `~/lib/store-edition-copy` to one of the two by the build's own
 * `STORE_PLATFORM` (`ios` / `android`), so the OTHER edition's sentences are not
 * in the bundle at all — not merely unrendered. `tools/store-build-check.mjs`
 * and `tools/aab-content-guard.sh` then assert, against the finished bundle,
 * that the correct wording is present and the wrong wording is absent; a build
 * that got it backwards fails instead of shipping.
 *
 * THIS FILE IS THE iOS SET, AND IT IS UNCHANGED FROM THE COPY THAT SHIPPED
 * BEFORE THE ANDROID FORK: it was checked against Apple's rules and a reviewer
 * reads it. Anything added here must stay true of a paid download in which the
 * store — not the app — took the money.
 *
 * `src/lib/store-edition-copy.ts` re-exports this file, which is what a build
 * with no `STORE_PLATFORM` (the web build, TypeScript, a script) resolves to.
 */
import { STORE_BUILD, STORE_PLATFORM } from "~/lib/build-flags";

/**
 * Every edition-naming sentence a store build renders, in one shape, so the two
 * editions cannot drift apart on structure — only on the words that must differ.
 * Shared facts (the finished-season count, what a posted run stores, the
 * affiliation line) are NOT here: they are true of both editions and live in
 * src/lib/legal.ts, where the two builds read the same sentences.
 */
export type StoreEditionCopy = {
  /** "ios" (paid App Store download) or "android" (free Play download). */
  readonly edition: "ios" | "android";
  /** /support <head> description. */
  readonly supportDescription: string;
  /** /privacy, "The short version" — the first paragraph, before the shared tail. */
  readonly privacyIntroLead: string;
  /** /privacy, the "no purchase" bullet under "No accounts, no cookies…". */
  readonly noPurchaseBullet: string;
  /** /support, "What the game is" — the second paragraph. */
  readonly supportWhatItIs: string;
  /** /support, "Refunds" — the first paragraph; the html-report paragraph is shared. */
  readonly supportRefundsLead: string;
  /** src/lib/legal.ts PURCHASE_LINE inside a store build. */
  readonly purchaseLine: string;
  /** src/lib/paywall.store.ts UNLOCK_BODY — shown where a run's included-ness is stated. */
  readonly unlockBody: string;
  /** src/lib/paywall.store.ts GAME_FOOTER — the home screen's footer line. */
  readonly gameFooter: string;
};

export const STORE_EDITION_COPY: StoreEditionCopy = {
  edition: "ios",

  supportDescription:
    "How to reach Gridiron Immortals, what to include when reporting a problem, and where refunds come from.",

  privacyIntroLead:
    "Gridiron Immortals is a paid app: the store you downloaded it from took one payment before it was installed. Inside the app there is no checkout, no account and no subscription, and every run is included.",

  noPurchaseBullet:
    "No purchase happens inside the app, so there is no card to take and no billing page to open. The store you bought it from handles the purchase and keeps its own record of it, under its own privacy policy.",

  supportWhatItIs:
    "This is the paid app: every run is included, there is nothing to buy inside it, and it plays with no network. The boards need a connection, and they say so when they do not have one.",

  supportRefundsLead:
    "The purchase was made through the app store you downloaded the game from, so that store handles refunds under its own rules — Apple and Google both have a request process in your purchase history. We never see your card and cannot charge or refund it.",

  purchaseLine:
    "Gridiron Immortals is a paid app: the store it was downloaded from took one payment, once, before it was installed. There is nothing recurring to cancel and no account to close.",

  unlockBody: "Every run is included in the app you bought.",

  gameFooter: "Runs save on this device. Every run is included in the version you bought.",
};

/**
 * The cross-check that catches the one failure the file swap cannot: if a build
 * is an Android store build and this file somehow got resolved anyway (a plugin
 * order change, a hand-edited import), the bundle would tell a Play reviewer it
 * is a paid app. That is false, and it is the exact sentence the free→paid rule
 * makes unfixable later — so fail loudly at load instead of shipping it. In
 * every other build (`STORE_BUILD` false, or platform "ios") this is dead.
 */
if (STORE_BUILD && STORE_PLATFORM !== "ios") {
  throw new Error(
    `store-edition-copy.ios.ts was loaded into a store build whose STORE_PLATFORM is ${String(
      STORE_PLATFORM,
    )} — an app-store build must resolve its own edition's copy (see vite.config.ts).`,
  );
}
