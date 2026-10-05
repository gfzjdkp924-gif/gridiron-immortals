/**
 * Gridiron Immortals — the build-time switches. One file, one flag, no runtime
 * detection of any kind.
 *
 * THERE ARE TWO BUILDS OF THE SAME GAME:
 *
 *   1. THE WEB BUILD (the default). Everything in the business plan's store
 *      description: the first run is free, the $4.99 one-time purchase takes the
 *      device past it, and the buy button opens the payment link. This is what
 *      `bun run build` and `bun run publish` produce, and it is what
 *      www.gridironimmortals.com serves.
 *
 *   2. THE STORE BUILD (`STORE_BUILD=1`, i.e. `bun run build:store`). An
 *      app-store download. The store collects the money BEFORE the app is
 *      installed, so inside this bundle there is nothing to sell: no paywall, no
 *      free-run allowance, no buy button, no checkout link, no price, and no
 *      `/unlock` route for a checkout to return to.
 *
 *      THERE ARE TWO OF THESE, AND THEY ARE NOT THE SAME PRODUCT IN ONE
 *      RESPECT: the App Store edition is a PAID app, and the Google Play edition
 *      is a FREE one (the owner's decision, 2026-10-05 — and one-way, because
 *      Google does not let a free app become paid). Which one a store build is,
 *      is `STORE_PLATFORM` below, and it is the ONLY thing the two store
 *      editions are allowed to differ on: the sentences that name the edition
 *      come from src/lib/store-edition-copy.ts (swapped per platform by
 *      vite.config.ts), and `tools/store-build-check.mjs` refuses to build a
 *      store bundle whose wording does not match its own platform.
 *
 * WHY ONE FLAG AND NOT TWO. The two builds differ in many places (the gate in
 * the game flow, the paywall panel, the boards' lock notes, the footers, the
 * legal pages, the route tree). A reader has to be able to answer "is the
 * paywall on in this bundle?" by looking at ONE thing. That thing is this file.
 *
 * THE DEFAULT IS THE WEB BUILD, ON PURPOSE. `STORE_BUILD` is false unless the
 * environment says exactly `STORE_BUILD=1` at build time, so the ordinary
 * `bun run build` — the one the publish pipeline runs — can never produce a
 * store bundle by accident. The other direction is covered too: a store build
 * runs `tools/store-build-check.mjs`, which greps the finished `dist/` and
 * FAILS the build if any web purchase surface survived into it, or if the
 * bundle's edition wording is the other edition's.
 *
 * `STORE_PLATFORM` IS REQUIRED BY A STORE BUILD AND FORBIDDEN TO THE WEB ONE.
 * It must be exactly `ios` or `android` when `STORE_BUILD=1`, and unset when it
 * is not — `vite.config.ts` throws on either mistake. There is deliberately no
 * default: a store build that guessed its edition would be a build that could
 * tell a Play reviewer it is a paid app, which is the one sentence Google's
 * free→paid rule makes permanent.
 *
 * HOW THE VALUES GET HERE. `vite.config.ts` replaces the identifiers
 * `__STORE_BUILD__` and `__STORE_PLATFORM__` with literals at build time (Vite's
 * `define`), in both the client and the server bundle. Nothing reads an
 * environment variable at runtime, and nothing in the browser can change it.
 *
 * The `typeof` checks are belt and braces: they keep this module working if it
 * is ever imported somewhere the defines were not applied (a script, a test),
 * and they fail towards the web build — the build that has a visible,
 * documented paywall — rather than towards a silent free game.
 */

declare const __STORE_BUILD__: boolean;
declare const __STORE_PLATFORM__: string | null;

/** True only in an app-store build. False in every other build. */
export const STORE_BUILD: boolean =
  typeof __STORE_BUILD__ === "boolean" ? __STORE_BUILD__ : false;

/**
 * WHICH STORE EDITION THIS BUNDLE IS: `"ios"` (the paid App Store download),
 * `"android"` (the free Google Play download), or `null` in every other build
 * including the web one. `__STORE_PLATFORM__` is a string literal baked in at
 * build time, so this is a compile-time fact, not a runtime probe.
 *
 * Anything that varies between the two store editions must ask about it here
 * rather than re-reading an environment variable; the value is what the guard
 * and the edition copy are checked against.
 */
export const STORE_PLATFORM: "ios" | "android" | null =
  typeof __STORE_PLATFORM__ === "string" && (__STORE_PLATFORM__ === "ios" || __STORE_PLATFORM__ === "android")
    ? __STORE_PLATFORM__
    : null;

/**
 * Is the device-gated paywall part of this bundle? Always the exact opposite of
 * `STORE_BUILD`, spelled out so that paywall code reads as a question rather
 * than as a negation: `if (PAYWALL_ENABLED) …` instead of `if (!STORE_BUILD) …`.
 */
export const PAYWALL_ENABLED: boolean = !STORE_BUILD;
