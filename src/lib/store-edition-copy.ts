/**
 * WHICH STORE EDITION'S COPY A BUILD RENDERS — the resolution point.
 *
 * `~/lib/store-edition-copy` is what every consumer imports
 * (`src/components/StoreLegalPages.tsx`, `src/lib/paywall.store.ts`,
 * `src/lib/legal.ts`). `vite.config.ts` decides what that specifier means for a
 * STORE build:
 *
 *   STORE_PLATFORM=ios      (the App Store build, `bun run build:store:ios`)
 *       → ./store-edition-copy.ios.ts      the paid download's wording
 *   STORE_PLATFORM=android  (the Play build, `bun run build:store:android`)
 *       → ./store-edition-copy.android.ts  the free download's wording
 *
 * THIS FILE IS THE NO-EDITION COPY, AND IT DELIBERATELY CLAIMS NO PRICE. It is
 * what a build that named no platform resolves to — the web build, TypeScript,
 * a script — and in a web build the store pages are tree-shaken away entirely
 * (`StorePrivacyPage` / `StoreSupportPage` are each behind a `STORE_BUILD ? … : …`
 * in src/routes/privacy.tsx and src/routes/support.tsx), so nothing here renders.
 *
 * WHY IT IS NEUTRAL RATHER THAN THE PAID SET (measured, 2026-10-05). This file
 * used to `export * from "./store-edition-copy.ios"`, and that ios module reaches
 * the *server* graph by a second resolution path that vite's `resolveId` swap
 * does not intercept. The result was an `STORE_PLATFORM=android` bundle that
 * shipped the App Store's "is a paid app" sentence into
 * `dist/server/assets/router-*.js` — caught by `bun tools/store-build-check.mjs`
 * as a build failure, which is exactly what that guard is for. A neutral default
 * cannot leak either store's claim into the other build, whatever path a module
 * reaches the graph by.
 *
 * SO THE GUARD CARRIES THE WHOLE BURDEN, IN BOTH DIRECTIONS: a store bundle must
 * contain its own edition's sentences ("This is the paid app" / "This is the free
 * app") and must not contain the other's (tools/store-edition-rules.mjs). If the
 * platform swap ever failed, the sentence would be *missing* and the build would
 * refuse to produce the bundle — rather than quietly shipping the wrong one. The
 * wording below is therefore true of any app-store download and names no price,
 * no purchase and no store: it is a floor, not a claim.
 *
 * Run `bun run store:www:ios` / `bun run store:www:android` to build a store
 * bundle; a bare `bun run store:www` is refused on purpose (there is no safe
 * default for a store edition).
 */

/** What every app-store download owes the reader, said without naming an edition. */
export const STORE_EDITION_COPY = {
  /** Which edition this is. Not an edition: see the note above. */
  edition: null as null | "ios" | "android",

  supportDescription:
    "How to reach Gridiron Immortals, what to include when reporting a problem, and where a refund comes from.",

  privacyIntroLead:
    "Gridiron Immortals came from an app store: there is no checkout, no account and no subscription inside it, and every run is included.",

  noPurchaseBullet:
    "No purchase happens inside the app, so there is no card to take and no billing page to open. Any payment was made to the store the app was downloaded from, which keeps its own record of it under its own privacy policy.",

  supportWhatItIs:
    "This is the app-store download: every run is included, there is nothing to buy inside it, and it plays with no network. The boards need a connection, and they say so when they do not have one.",

  supportRefundsLead:
    "The download came from an app store, and that store handles refunds under its own rules — Apple and Google both keep a request process in your purchase history. We never see your card and cannot charge or refund it.",

  purchaseLine:
    "Gridiron Immortals came from an app store, which handled the download before it was installed. There is nothing recurring to cancel and no account to close.",

  unlockBody: "Every run is included.",

  gameFooter: "Runs save on this device. Every run is included.",
} as const;
