import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

import { SITE_URL } from "./src/lib/site";

/* ==========================================================================
 * THE STORE BUILD SWITCH — the whole difference between the two builds.
 *
 *   bun run build          → THE WEB BUILD (the default). Nothing set: the free
 *                            first run, the $4.99 unlock and the buy button all
 *                            ship exactly as they do today, and the publish
 *                            pipeline (publish.sh → `bun run build`) is
 *                            untouched by any of this.
 *   STORE_BUILD=1 …        → A STORE BUILD (`bun run build:store`). An app-store
 *                            download: no paywall, no free-run gate, no buy
 *                            link, no price, no `/unlock` route.
 *
 * AND WHICH STORE IT IS, because there are two editions now and they are not the
 * same product in one respect:
 *
 *   STORE_PLATFORM=ios     → the PAID App Store download ($4.99, taken by the
 *                            store before install). The wording that ships today.
 *   STORE_PLATFORM=android → the FREE Google Play download (no price, no
 *                            purchase, nothing to unlock). The owner's decision,
 *                            2026-10-05, and a one-way one — Google will not let
 *                            a free app become paid — which is why no sentence in
 *                            that edition may hint at a price to come.
 *
 * The two flags are read HERE, once, and nothing else in the tree reads an
 * environment variable for this. What they do:
 *
 *   1. `define: { __STORE_BUILD__, __STORE_PLATFORM__ }` bakes the literals into
 *      both the client and the server bundle, so `STORE_BUILD` and
 *      `STORE_PLATFORM` (src/lib/build-flags.ts) are constants the minifier can
 *      fold and the runtime cannot change.
 *   2. `~/lib/paywall` — every price, buy URL and paywall sentence in the game —
 *      is resolved to `src/lib/paywall.store.ts` instead, so no web purchase
 *      string is even in the module graph of a store build.
 *   3. `~/lib/store-edition-copy` — every sentence that names the edition (paid
 *      app vs free app: the /privacy and /support pages, the home footer, the
 *      one-line purchase statement) — is resolved to the file for THIS platform,
 *      so the other edition's sentences are not in the bundle at all. That is
 *      what makes "the Android bundle cannot say it is a paid app" a fact rather
 *      than a hope; `tools/store-build-check.mjs` then asserts it against dist/.
 *   4. the `/unlock` route file is excluded from the generated route tree, so
 *      the store build has no checkout-return route to navigate to and no
 *      `/unlock` path in its bundled router.
 *
 * SHIPPING THE WRONG ONE IS THE FAILURE MODE THAT MATTERS, in every direction:
 *   - the default is the web build, so a forgotten flag cannot produce a store
 *     bundle on the public site;
 *   - a store build with no platform, or a web build that names one, THROWS
 *     right here — a store build that guessed its edition could hand a Play
 *     reviewer a page that says the app is paid, and Google's free→paid rule
 *     means that sentence could never be made true afterwards;
 *   - `bun run build:store` runs `tools/store-build-check.mjs store` afterwards,
 *     which greps the finished `dist/` for `buy.stripe.com`, `/unlock`,
 *     "first run free" and `$4.99` and FAILS the build if any survived — and
 *     which now also FAILS if the bundle carries the other edition's wording;
 *   - `bun run check:web` asserts those four markers ARE present in an ordinary
 *     build, which is what proves the flag really toggles something.
 * ========================================================================== */
const STORE_BUILD_FLAG = process.env.STORE_BUILD;
if (STORE_BUILD_FLAG !== undefined && STORE_BUILD_FLAG !== "0" && STORE_BUILD_FLAG !== "1") {
  // A typo must never quietly produce the wrong build: "true", "yes" or "store"
  // would all look like "the flag is set" to a reader while building the web
  // bundle.
  throw new Error(
    `STORE_BUILD must be exactly "1" (an app-store build) or "0"/unset (the web build); got "${STORE_BUILD_FLAG}"`,
  );
}
const STORE_BUILD = STORE_BUILD_FLAG === "1";

/**
 * WHICH STORE EDITION — `"ios"` (paid App Store download), `"android"` (free
 * Google Play download), or `null` for every other build (the web build).
 *
 * Both mistakes throw here, and both matter: a store build with no platform
 * would have to guess which store it is, and the guess that says "paid app" is
 * false for Android in a way Google will not let us fix later; a web build that
 * names a platform is a sign the flag was meant for a different build and that
 * something is about to ship under the wrong name.
 */
const STORE_PLATFORM_FLAG = process.env.STORE_PLATFORM;
if (
  STORE_PLATFORM_FLAG !== undefined &&
  STORE_PLATFORM_FLAG !== "" &&
  STORE_PLATFORM_FLAG !== "ios" &&
  STORE_PLATFORM_FLAG !== "android"
) {
  throw new Error(
    `STORE_PLATFORM must be exactly "ios" (the paid App Store download) or "android" (the free Play download); got "${STORE_PLATFORM_FLAG}"`,
  );
}
const STORE_PLATFORM: "ios" | "android" | null =
  STORE_PLATFORM_FLAG === "ios" || STORE_PLATFORM_FLAG === "android" ? STORE_PLATFORM_FLAG : null;
if (STORE_BUILD && STORE_PLATFORM === null) {
  throw new Error(
    'a store build must name its edition: set STORE_PLATFORM=ios (the paid App Store download) or STORE_PLATFORM=android (the free Play download). There is no default on purpose — the wrong one ships a sentence a store reviewer can see and Google will not let us undo.',
  );
}
if (!STORE_BUILD && STORE_PLATFORM !== null) {
  throw new Error(
    `STORE_PLATFORM=${STORE_PLATFORM} is set but this is not a store build (STORE_BUILD is not "1"). Set STORE_BUILD=1 as well, or unset STORE_PLATFORM — the web build has no edition.`,
  );
}


/**
 * WHERE THE APP'S API CALLS GO (src/lib/api-base.ts).
 *
 * The web build's pages are served BY the API, so its calls stay relative and
 * this is `""`. The store build's pages are local files on the app's own origin
 * (`capacitor://localhost`), so its calls must be absolute or they hit the app
 * itself and find nothing: this is the game's canonical origin plus `/api`,
 * taken from SITE_URL (src/lib/site.ts, the one place the address is written
 * down) and baked in as a literal so the finished bundle can be grepped for it
 * (tools/make-store-www.sh does exactly that, before Capacitor copies the
 * folder).
 *
 * It is not a second switch: it is derived from the same `STORE_BUILD` value
 * above, so build-flags.ts remains the one answer to "which build is this?".
 */
const STORE_API_BASE = STORE_BUILD ? `${SITE_URL}/api` : "";

const srcFile = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * Point `~/lib/paywall` at the store build's money words.
 *
 * `enforce: "pre"` so this runs before the tsconfig-paths resolver, which is
 * what would otherwise turn `~/lib/paywall` back into the web module. Only the
 * store build resolves anything here: the web build returns null and the import
 * resolves to `src/lib/paywall.ts` exactly as it always has.
 *
 * This replaces the swap an alias would do, but deterministically and with the
 * reason written down next to it: an alias competes with the tsconfig-paths
 * plugin for the same specifier, and which one wins is an implementation detail
 * of plugin ordering.
 */
const storePaywallSwap: Plugin = {
  name: "gridiron-store-paywall-swap",
  enforce: "pre",
  resolveId(source) {
    if (STORE_BUILD && source === "~/lib/paywall") return srcFile("./src/lib/paywall.store.ts");
    return null;
  },
};

/**
 * Point `~/lib/store-edition-copy` at THIS edition's sentences.
 *
 * The module holds the sentences that say what the app is — a paid app in the
 * App Store download, a free one in the Play download — and the two editions
 * must not be able to reach each other's copy: a Play reviewer opening /privacy
 * or /support inside the Android app must not read "Gridiron Immortals is a paid
 * app". Resolving the specifier per platform (rather than selecting between two
 * objects at runtime) means the wrong sentences are not merely unrendered, they
 * are absent from the bundle — which is the only version of that claim a later
 * reader can check with grep.
 *
 * `enforce: "pre"` for the same reason as the paywall swap above: it must beat
 * the tsconfig-paths resolver that would otherwise turn `~/lib/store-edition-copy`
 * back into the default (iOS) file. Only store builds resolve anything here; the
 * web build returns null and gets `src/lib/store-edition-copy.ts`, the iOS
 * re-export, which its own tree-shaking then drops.
 */
const storeEditionSwap: Plugin = {
  name: "gridiron-store-edition-swap",
  enforce: "pre",
  resolveId(source) {
    if (!STORE_BUILD || source !== "~/lib/store-edition-copy") return null;
    return srcFile(
      STORE_PLATFORM === "android"
        ? "./src/lib/store-edition-copy.android.ts"
        : "./src/lib/store-edition-copy.ios.ts",
    );
  },
};

export default defineConfig({
  // The build-time constants behind `STORE_BUILD` / `STORE_PLATFORM`
  // (src/lib/build-flags.ts) and `apiUrl` (src/lib/api-base.ts). All are folded
  // in; none is readable or changeable at runtime.
  define: {
    __STORE_BUILD__: JSON.stringify(STORE_BUILD),
    __STORE_PLATFORM__: JSON.stringify(STORE_PLATFORM),
    __STORE_API_BASE__: JSON.stringify(STORE_API_BASE),
  },
  server: {
    port: 3000,
    host: true,
    // The site is reverse-proxied behind <label>.<PUBLIC_SITE_DOMAIN>; the proxy
    // masks the Host to localhost:3000, but accept any host so a dev server never
    // rejects a proxied request with "Blocked request".
    allowedHosts: true,
    // The dev server is reachable through the TLS proxy, so the HMR websocket
    // must dial back on 443, not the dev port. If the socket can't connect,
    // pages still serve — hot reload degrades, never breaks.
    hmr: { clientPort: 443 },
    // The dev server can serve source files; never let it serve local secrets,
    // and never let it serve anything outside the site dir. Gotchas this list
    // encodes: a custom `deny` REPLACES Vite's defaults (so .git must be
    // restated), patterns containing "/" match the ABSOLUTE path (so dir
    // patterns need a leading **/), and `allow` left to its default widens to
    // the nearest workspace root — a stray .git or workspaces package.json in
    // /home/team/shared would expose the whole shared dir.
    fs: {
      strict: true,
      allow: [import.meta.dirname],
      deny: [".env", ".env.*", "*.{crt,pem,key}", "**/.run/**", "**/.git/**"],
    },
  },
  plugins: [
    storePaywallSwap,
    storeEditionSwap,
    tailwindcss(),
    tsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    // `router.routeFileIgnorePattern` is matched against each route FILE NAME
    // under src/routes. Excluding unlock.tsx is what removes `/unlock` from the
    // store build: the file stays on disk (the web build needs it) but the
    // generated route tree never imports it, so a store bundle contains no such
    // path and nothing to navigate to.
    tanstackStart(
      STORE_BUILD ? { router: { routeFileIgnorePattern: "^unlock\\.tsx$" } } : {},
    ),
    viteReact(),
  ],
});
