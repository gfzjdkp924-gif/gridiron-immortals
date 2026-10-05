/**
 * Gridiron Immortals — the ONE place that decides where the game's own server is.
 *
 * THE PROBLEM THIS SOLVES. One codebase produces two builds (src/lib/build-flags.ts):
 *
 *   - THE WEB BUILD is served BY the server it talks to. `"/api/leaderboard"`
 *     is the address the page itself came from, and it must stay relative: the
 *     same bundle is served from the owner's domain AND from the team's preview
 *     address, so any hard-coded origin would break one of them.
 *
 *   - THE STORE BUILD is a bundled Capacitor app. Its pages are local files
 *     loaded from the app's own origin — `capacitor://localhost` on iOS,
 *     `https://localhost` on Android — so a relative `"/api/leaderboard"` there
 *     is a request to the app itself, which has no server in it. Every board
 *     call would come back empty, the profile would show nothing, and the
 *     finished-run counter would count nothing. The app has to address the
 *     published server absolutely.
 *
 * So: relative in the web build, absolute in the store build, decided once,
 * here, from the same `STORE_BUILD` switch every other build difference reads.
 * All four client modules that fetch use this: board-api, players-board-api,
 * profile-api, run-count.
 *
 * WHERE THE ADDRESS COMES FROM. Not from here. `vite.config.ts` bakes
 * `${SITE_URL}/api` in as a literal at build time (Vite `define`), and
 * `SITE_URL` (src/lib/site.ts) is the game's single canonical origin — the one
 * the share card prints and the link preview points at. The app therefore calls
 * exactly the origin the card sends people to, and there is only ever one line
 * to change if that address ever changes. Baking it in also means the store
 * bundle contains the absolute base as one greppable string, which is what
 * `tools/make-store-www.sh` checks before the folder is handed to Capacitor.
 *
 * NOTHING HERE IS ABOUT MONEY. No price, no purchase wording, no checkout path:
 * this module is an address and nothing else, which is why it is safe in both
 * builds. (The store build's own guard scans the finished bundle for purchase
 * surfaces — nothing in this file could trip it.)
 *
 * THE ONE COST, STATED PLAINLY. Inside the app these calls need a network
 * connection, exactly as they do in a phone browser. The game itself is fully
 * playable offline either way: every caller already turns a request that cannot
 * be made into its own "offline" state and carries on (board-api, profile-api,
 * run-count), and no run is ever lost to a board that cannot be reached.
 */
import { STORE_BUILD } from "~/lib/build-flags";

/**
 * The absolute API base, replaced at build time — `""` in the web build, and the
 * game's own origin plus `/api` in the store build. `declare` because it never
 * exists at runtime: Vite substitutes the identifier before the bundle is
 * minified (see vite.config.ts).
 */
declare const __STORE_API_BASE__: string;

/**
 * The belt-and-braces read. `typeof` keeps this module working if it is ever
 * loaded somewhere the define was not applied (a test, a script run by bun), and
 * it fails towards the web build — the build whose calls are relative and which
 * therefore works wherever it is served from — rather than towards an app that
 * silently talks to the wrong host.
 */
const STORE_API_BASE: string = typeof __STORE_API_BASE__ === "string" ? __STORE_API_BASE__ : "";

/**
 * A `/api/…` path → the address to fetch it from.
 *
 *   web build   "/api/leaderboard" → "/api/leaderboard"                            (unchanged)
 *   store build "/api/leaderboard" → "https://www.gridironimmortals.com/api/leaderboard"
 *
 * THE ONE DETAIL THAT HAS TO BE RIGHT, AND WAS NOT. Every caller passes a path
 * that ALREADY begins with `/api` — that is exactly what makes the web build's
 * call relative and same-origin — while the baked base already ends in `/api`
 * (vite.config.ts builds it from `SITE_URL`). Joining them as they come gives
 * `…/api/api/leaderboard`, which the server answers 404/500: inside the app the
 * boards, the player rating and the finished-run counter were all dead while
 * every same-origin curl of the routes looked healthy. So the leading `/api` is
 * dropped here, exactly once, and only on the store path — the web build's
 * address is returned untouched, byte for byte.
 */
export const apiUrl = (path: string): string =>
  STORE_BUILD ? `${STORE_API_BASE}${path.replace(/^\/api(?=\/|$)/, "")}` : path;
