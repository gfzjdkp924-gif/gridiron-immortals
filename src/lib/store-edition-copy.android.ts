/**
 * WHAT AN APP-STORE BUILD SAYS ABOUT ITS OWN EDITION — the Google Play (free) set.
 *
 * The owner decided on 2026-10-05 that the Android app ships FREE on Google
 * Play. The App Store build stays a paid download. `vite.config.ts` resolves
 * `~/lib/store-edition-copy` to this file only when the build's `STORE_PLATFORM`
 * is `android`, so the App Store's "paid app" sentences are not in the Android
 * bundle at all.
 *
 * THE RULE EVERY SENTENCE BELOW FOLLOWS, and the reason it cannot borrow the web
 * game's wording: Google's free→paid change is ONE WAY — "You can change your app
 * from paid to free. Once your app has been offered for free, the app can't be
 * changed to paid."
 * (https://support.google.com/googleplay/android-developer/answer/6334373)
 * So nothing here may suggest a price that is coming, a trial, an upgrade, a
 * "full version", a launch offer, or a "for now" — and it must not repeat the web
 * game's "first run free, then $4.99", because no such mechanic exists in this
 * download: in this build there is no paywall, no price, no checkout link and no
 * `/unlock` route (that is what `tools/store-build-check.mjs` refuses to build).
 * Each sentence states, in the present tense, a fact that stays true for as long
 * as the app is free: it costs nothing, nothing is bought, nothing is unlocked.
 *
 * It is also true of this build that there are no ads, no analytics, no accounts
 * and no cookies — but those sentences are shared with the App Store edition in
 * `src/components/StoreLegalPages.tsx` and `src/lib/legal.ts`, so they are stated
 * once, there, and this file does not repeat them.
 *
 * NO IMPORTS OF VALUES, ON PURPOSE. `import type` is erased by the build, so
 * nothing in the App Store edition's module can reach an Android bundle through
 * this file (the two guards prove it against the finished bundle).
 */
import type { StoreEditionCopy } from "./store-edition-copy.ios";
import { STORE_BUILD, STORE_PLATFORM } from "~/lib/build-flags";

export const STORE_EDITION_COPY: StoreEditionCopy = {
  edition: "android",

  supportDescription:
    "How to reach Gridiron Immortals, what to include when reporting a problem, and why this free app has nothing to refund.",

  privacyIntroLead:
    "Gridiron Immortals is a free app: it costs nothing to download and nothing to play, and every run is included. Inside the app there is no checkout, no account and no subscription, nothing to unlock and nothing to buy.",

  noPurchaseBullet:
    "The app is free, and no purchase happens anywhere in it, so there is no card to take, no billing page to open and nothing to unlock. There is nothing to buy inside it.",

  supportWhatItIs:
    "This is the free app: every run is included, it costs nothing to download or play, there is nothing to buy inside it, and it plays with no network. The boards need a connection, and they say so when they do not have one.",

  supportRefundsLead:
    "There is nothing to refund: the app is free, so no money changed hands, no card was taken and no purchase was made. There is nothing to cancel and no receipt to keep either.",

  purchaseLine:
    "Gridiron Immortals is a free app: it costs nothing to download and nothing to play, and there is nothing in it to buy. There is no subscription, no account and nothing recurring to cancel.",

  unlockBody: "Every run is included, and the app is free.",

  gameFooter: "Runs save on this device. Every run is included, and the app is free.",
};

/**
 * The mirror of the check in `store-edition-copy.ios.ts`: if an iOS store build
 * ever resolved this file, the paid app would tell an Apple reviewer it is free
 * — false in the same way, and worth failing loudly at load rather than shipping.
 */
if (STORE_BUILD && STORE_PLATFORM !== "android") {
  throw new Error(
    `store-edition-copy.android.ts was loaded into a store build whose STORE_PLATFORM is ${String(
      STORE_PLATFORM,
    )} — a store build must resolve its own edition's copy (see vite.config.ts).`,
  );
}
