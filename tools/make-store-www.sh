#!/usr/bin/env bash
# Assemble the native wrapper's web bundle: www-store/
#
# This is the step between "the store build compiles" and "Capacitor has
# something to copy into the Xcode / Android Studio projects". It does five
# things, in order, and stops at the first one that fails:
#
#   1. builds the STORE build (STORE_BUILD=1 and STORE_PLATFORM=ios|android: no
#      paywall, no price, no buy link, no /unlock route, and this edition's own
#      wording on the legal pages),
#   2. runs the post-build guard, which greps the finished dist/ and refuses to
#      go on if any web purchase surface survived into it OR if the bundle carries
#      the other store edition's wording,
#   3. copies the built client files into www-store/,
#   4. snapshots the server-rendered shell of "/" as www-store/index.html,
#      because the app is a server-rendered TanStack Start site and Capacitor
#      needs a real index.html to load. The snapshot is taken from a throwaway
#      server bound to a spare port, so it never touches the site running on
#      :3000. Route folders (leaderboard/, players/, ...) get the same shell so a
#      deep link inside a bundled app still loads; ordinary taps in the app are
#      client-side navigations and never hit the file server at all.
#
# The fifth is not packaging at all: it checks the edition wording a second time,
# on www-store/ instead of dist/ — because www-store/ is
# the folder Capacitor copies into the installed app, and a stale one from an
# earlier run is exactly how the wrong store's sentences would get in.
#
# Run from anywhere: `bun run store:www` with STORE_PLATFORM set, or
# `bun run store:www:ios` / `bun run store:www:android` (equivalently
# `bash tools/make-store-www.sh <ios|android>`).
#
# THE EDITION IS REQUIRED AND HAS NO DEFAULT. A store build must say which store
# it is: the App Store edition is a PAID app and the Play edition is a FREE one,
# the sentences that say so come from src/lib/store-edition-copy.ts, and a bundle
# that guessed "paid" for Android hands a Play reviewer a claim Google's free→paid
# rule means we could never make true afterwards. So STORE_PLATFORM is mandatory
# here (see tools/store-edition-rules.mjs), and it reaches the build through
# vite.config.ts.
#
# Output: ./www-store — what capacitor.config.ts names as `webDir`.
set -euo pipefail
cd "$(dirname "$0")/.."

SHELL_PORT=3411
WWW="www-store"

PLATFORM="${1:-${STORE_PLATFORM:-}}"
case "$PLATFORM" in
  ios | android) ;;
  "")
    echo "make-store-www: STORE_PLATFORM is not set, and a store build must name its edition:" >&2
    echo "  STORE_PLATFORM=ios (the paid App Store download) or STORE_PLATFORM=android (the free" >&2
    echo "  Google Play download). Try 'bun run store:www:ios' or 'bun run store:www:android'." >&2
    exit 2
    ;;
  *)
    echo "make-store-www: STORE_PLATFORM must be 'ios' or 'android'; got '$PLATFORM'" >&2
    exit 2
    ;;
esac
export STORE_PLATFORM="$PLATFORM"
echo "make-store-www: edition = $PLATFORM"

echo "[1/5] building the store build"
STORE_BUILD=1 bun run build
echo "[2/5] checking the finished bundle for web purchase surfaces and the $PLATFORM wording"
bun tools/store-build-check.mjs store

echo "[3/5] assembling $WWW/"
rm -rf "$WWW"
mkdir -p "$WWW"
cp -R dist/client/. "$WWW/"

# The app's own copies of the board, the profile and the run counter live on the
# game's server, and this bundle's pages are local files on the app's own origin
# (capacitor://localhost / https://localhost). A relative /api/… call would be a
# request to the app itself, which has no server in it — the boards would come up
# empty on a reviewer's phone. src/lib/api-base.ts is where that is decided, and
# vite.config.ts bakes the absolute base in from SITE_URL (src/lib/site.ts, the
# one place the address is written down). So: the address is read from that same
# file here, and the finished bundle must contain it. Fail the build rather than
# hand Capacitor a folder whose boards cannot reach the server.
API_BASE="$(bun -e 'import { SITE_URL } from "./src/lib/site.ts"; process.stdout.write(`${SITE_URL}/api`)')"
if [ -z "$API_BASE" ]; then
  echo "make-store-www: could not read SITE_URL from src/lib/site.ts" >&2
  exit 1
fi
if ! grep -rqF "$API_BASE" "$WWW"; then
  echo "make-store-www: $WWW/ never names $API_BASE — the app's boards would be dead inside the app" >&2
  exit 1
fi
echo "  ok: the bundle addresses the API absolutely at $API_BASE"

echo "[4/5] snapshotting the app shell for index.html and the route folders"
# The throwaway server is written INTO the project root, not /tmp: the built
# server is imported as "./dist/server/server.js", and a bare relative import
# resolves against the importing FILE's own directory. In /tmp it resolved to
# /tmp/dist/server/server.js and the helper died with "Cannot find module",
# which showed up as "the shell server did not answer on port 3411".
SHELL_SERVER="./.store-shell.ts"
cat > "$SHELL_SERVER" <<'TS'
// Throwaway: the built server, bound to a spare port, only to fetch the HTML
// shell of "/" for the bundled app. Nothing else is asked of it.
import handler from "./dist/server/server.js";

const port = Number(process.env.SHELL_PORT ?? 3411);
const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(request: Request) {
    return (handler as { fetch: (r: Request) => Response | Promise<Response> }).fetch(request);
  },
});
console.log(`shell server on ${String(server.port)}`);
TS
SHELL_PORT="$SHELL_PORT" bun "$SHELL_SERVER" >/tmp/gridiron-store-shell.log 2>&1 &
SHELL_PID=$!
# shellcheck disable=SC2064 # expand the pid now, not when the trap fires
trap "kill $SHELL_PID 2>/dev/null || true; rm -f '$SHELL_SERVER'" EXIT

for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "http://127.0.0.1:$SHELL_PORT/"; then break; fi
  sleep 0.5
done
if ! curl -sf -o "$WWW/index.html" "http://127.0.0.1:$SHELL_PORT/"; then
  echo "make-store-www: the shell server did not answer on port $SHELL_PORT" >&2
  echo "  (see /tmp/gridiron-store-shell.log)" >&2
  exit 1
fi
if ! grep -q "Gridiron" "$WWW/index.html"; then
  echo "make-store-www: the snapshot does not look like the game's shell" >&2
  exit 1
fi

# Deep links inside the bundle: same shell, one folder per route. The client
# router does the rest, exactly as it does on the web.
for route in leaderboard players profile privacy support; do
  mkdir -p "$WWW/$route"
  cp "$WWW/index.html" "$WWW/$route/index.html"
done

echo
echo "[5/5] proving $WWW/ carries the $PLATFORM edition's wording"
# The same check the guard just ran on dist/, run again on the folder that
# actually becomes the app's pages. It is not redundant: www-store/ is rebuilt by
# copying, so a stale index.html or a chunk left over from an earlier edition is
# possible in a way that dist/ is not, and this is the folder `npx cap sync`
# hands to Xcode and to Gradle.
bun tools/store-edition-check.mjs "$WWW" "$PLATFORM"
echo
echo "www-store/ is ready ($(find "$WWW" -type f | wc -l) files, $(du -sh "$WWW" | cut -f1)) — $PLATFORM edition."
echo "Next: on a machine with the store toolchains, npx cap sync (see"
echo "/home/team/shared/appstore/store-build-runbook.md)."
