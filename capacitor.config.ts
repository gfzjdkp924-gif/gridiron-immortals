import type { CapacitorConfig } from "@capacitor/cli";

/**
 * THE NATIVE WRAPPER — Capacitor config for the paid app-store build.
 *
 * WHAT THIS WRAPS. Not a URL: `www-store/` is a real directory of files built
 * from this repo by `bun run store:www` (tools/make-store-www.sh), which runs
 * the STORE build (`STORE_BUILD=1`, see vite.config.ts and src/lib/build-flags.ts)
 * and then copies the built client into `www-store/`. The paid app must work
 * offline exactly like the web build does, so the game is bundled inside the app
 * rather than loaded from the internet — and because the bundle is the store
 * build, there is no paywall, no price and no checkout link inside it.
 *
 * APP IDENTITY (chosen here, written down once):
 *   appId      com.gridironimmortals.game
 *   appName    Gridiron Immortals
 * The appId is the iOS Bundle Identifier and the Android applicationId. It is
 * permanent for a store listing, so it is deliberately the owner's own domain
 * reversed, not the platform preview host.
 *
 * FIRST TIME ON THE MAC (see /home/team/shared/appstore/store-build-runbook.md):
 *   npm install                       # installs @capacitor/cli, core, ios, android
 *   npx cap add ios                   # creates the Xcode project
 *   npx cap add android               # creates the Android Studio project
 *   npx cap sync                      # copies www-store/ into both projects
 * The generated `node_modules/` folder is build output and is NOT committed. `ios/` and `android/`
 * are different, and this comment used to get them wrong: they do not exist until you run the two
 * `npx cap add` commands above, and once they do they are meant to be KEPT, not ignored — they hold
 * the Xcode/Android Studio projects, the icon slots, the signing settings and the privacy manifest.
 * Nothing here gitignores them today. Whatever repository ends up holding this project (one is
 * coming) should ignore `node_modules/`, `dist/` and `.run/` and COMMIT `ios/` and `android/`.
 * `www-store/` is derived — `bun run store:www` rebuilds it from source in one command — so if it is
 * committed, treat it as a checked-in build: re-run that command after ANY change to the game or to
 * src/lib/api-base.ts, or the app built from it is stale. (It was stale once: the folder shipped a
 * broken API join until 2026-10-05 — see /home/team/shared/appstore/screenshots/README.md.)
 */
const config: CapacitorConfig = {
  appId: "com.gridironimmortals.game",
  appName: "Gridiron Immortals",
  webDir: "www-store",
  // Both platforms keep the game's own dark background behind the WebView, so a
  // slow first paint (or a rotation) never flashes white.
  backgroundColor: "#070c17",
  ios: {
    // The game draws its own safe-area padding; "always" lets the WebView scroll
    // under the notch instead of leaving a band of dead space.
    contentInset: "always",
    backgroundColor: "#070c17",
  },
  android: {
    backgroundColor: "#070c17",
    // The bundled pages are local files; nothing in the store build needs mixed
    // content, and the boards are https, so keep it off.
    allowMixedContent: false,
  },
  // NOT set on purpose: `server.url`. A paid offline app must not be a browser
  // pointed at a website — the whole point of bundling is that the game plays
  // with no network, and that the shipped copy is the reviewed copy.
};

export default config;
