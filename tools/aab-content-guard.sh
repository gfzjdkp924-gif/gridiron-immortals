#!/usr/bin/env bash
# =====================================================================================
#  THE AAB CONTENT GUARD — the Android twin of `bun tools/store-build-check.mjs`
# =====================================================================================
#
#  WHAT IT ANSWERS. Once Gradle has produced the release bundle, this script opens
#  the .aab (an .aab is a zip) and answers one question: are the web files INSIDE
#  this bundle the guarded STORE build, or did a web build with a purchase surface
#  on it get in there?
#
#  That check is not a formality. `bun run store:www` (step 2 of the build) already
#  refuses to produce a bundle with a purchase surface in it, but what Gradle packs
#  is whatever is in `android/app/src/main/assets/public/` at that moment — a stale
#  copy from an earlier run, a `npx cap sync` against a web build, a hand-copied
#  folder. Nothing else in the pipeline looks inside the finished .aab, so this is
#  the one check that runs against the artifact that would actually be uploaded, and
#  the one a reviewer's rejection would come from:
#    • Play's payments policy — a download on Play must not steer anyone to an
#      outside payment: https://support.google.com/googleplay/android-developer/answer/9858738
#    • the price and the "first run free" wording, which only make sense when there
#      is something to buy on the web — and the Play app is free, so neither the
#      price nor the free-first-run promise describes anything in it.
#
#  THE FOUR MARKERS ARE THE SAME FOUR the store-build guard uses (and the same four
#  that are deliberately PRESENT in the web build): the Stripe payment link, the
#  /unlock route, "first run free", and $4.99. Any one of them inside the .aab is a
#  failure. Two more are reported but never fatal, because they are legitimate
#  English in an app: the word "stripe" and the word "unlock".
#
#  IT ALSO CHECKS WHICH STORE EDITION'S WORDING IS INSIDE. This bundle goes to
#  Google Play, where the app is FREE (the owner's decision, 2026-10-05) — but the
#  same web files are packaged for the App Store, where it is PAID, and a stale
#  assets/public/ can carry that edition's sentences. So the edition is a required
#  argument and the wording is checked with the same rules the store guard uses
#  (tools/store-edition-rules.mjs, via tools/store-edition-check.mjs): an Android
#  bundle must say the app is free and must not contain "paid app" anywhere, and
#  the reverse holds for an App Store bundle. Google's rule that makes the free
#  edition permanent, and the reason this is worth refusing to build for:
#  "Once your app has been offered for free, the app can't be changed to paid."
#  https://support.google.com/googleplay/android-developer/answer/6334373
#
#  It also refuses a bundle whose web assets are missing entirely (which would be an
#  app that opens to nothing) and, if you pass the app's API address as the second
#  argument, refuses a bundle whose pages would not be able to reach the game's
#  server — the same failure `bun run store:www` guards for, checked again on the
#  artifact.
#
#  Usage:
#     bash tools/aab-content-guard.sh <path/to/app-release.aab> [https://host/api] [ios|android]
#  Exit: 0 = the bundle is the store build, of the edition asked for; 1 = it is not,
#  and the log says which file carried which marker or which phrase.
# =====================================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

AAB="${1:-}"
EXPECTED_API_BASE="${2:-}"
EDITION="${3:-android}"

if [ -z "$AAB" ] || [ ! -f "$AAB" ]; then
  echo "usage: bash tools/aab-content-guard.sh <path/to/app-release.aab> [expected-api-base] [ios|android]" >&2
  exit 2
fi
if [ "$EDITION" != "android" ] && [ "$EDITION" != "ios" ]; then
  echo "aab-content-guard: the edition must be 'android' (the free Play download) or 'ios' (the paid App Store download); got '$EDITION'" >&2
  exit 2
fi
# The edition rules live in one place, shared with the store guard that runs on
# dist/. They are a bun script, so bun has to be here — the Android workflow sets
# Bun up before this step, and failing loudly is right: an unrun edition check is
# exactly the "it looked fine" that this script exists to prevent.
if ! command -v bun >/dev/null 2>&1; then
  echo "aab-content-guard: bun is not on this machine, so the store-edition wording check cannot run." >&2
  echo "  It is not optional: it is what proves the app in this bundle says the right thing about" >&2
  echo "  its price. Install bun (the Android workflow sets it up before this step) and re-run." >&2
  exit 2
fi
if ! command -v unzip >/dev/null 2>&1; then
  echo "aab-content-guard: unzip is not on this machine" >&2
  exit 2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "aab-content-guard: inspecting $AAB ($(du -h "$AAB" | cut -f1)), expecting the $EDITION edition"

# An .aab is a zip; if it is not, nothing below means anything.
if ! unzip -l "$AAB" > "$WORK/entries.txt" 2>"$WORK/unzip.err"; then
  echo "aab-content-guard: FAIL — this is not a readable zip archive, so it is not an .aab" >&2
  cat "$WORK/unzip.err" >&2
  exit 1
fi
entries="$(grep -c 'base/' "$WORK/entries.txt" || true)"
echo "  $entries entries under base/ (the Android module)"

# ---- 1. the bundle must BE an app bundle, not a zip of something else --------------
if ! grep -q 'base/manifest/AndroidManifest.xml' "$WORK/entries.txt"; then
  echo "aab-content-guard: FAIL — no base/manifest/AndroidManifest.xml inside the archive." >&2
  echo "  That file is what makes an .aab an app bundle. What was uploaded is not one." >&2
  exit 1
fi
echo "  ok: base/manifest/AndroidManifest.xml is present (this is an app bundle)"

# Extract, and then look at real files rather than at a listing.
unzip -q -o "$AAB" -d "$WORK/x"

# ---- 2. the web assets must be there, and they must be the whole app ---------------
PUBLIC_DIR="$(find "$WORK/x" -type d -path '*/assets/public' | head -1)"
if [ -z "$PUBLIC_DIR" ]; then
  echo "aab-content-guard: FAIL — the bundle carries no web assets (no */assets/public/ directory)." >&2
  echo "  An app built from this bundle would open to a blank screen. Capacitor copies" >&2
  echo "  capacitor.config.ts's webDir (www-store/) into android/app/src/main/assets/public/," >&2
  echo "  so this usually means 'npx cap sync android' never ran, or ran against a folder" >&2
  echo "  that was not there. Here is what IS under assets/:" >&2
  find "$WORK/x" -type d -path '*/assets*' | head -20 >&2
  exit 1
fi
echo "  ok: web assets found at ${PUBLIC_DIR#"$WORK/x"/}"

if [ ! -f "$PUBLIC_DIR/index.html" ]; then
  echo "aab-content-guard: FAIL — the web assets have no index.html, so the WebView has no page to load." >&2
  exit 1
fi

# ---- 3. THE CHECK THIS SCRIPT EXISTS FOR -------------------------------------------
# -I = skip binary files, so the .dex and .pb files are ignored and nothing inside a
# PNG can be mistaken for a match. -E = the patterns are regular expressions.
MARKERS=(
  'the Stripe payment link|buy\.stripe\.com'
  'the /unlock route (or a link to it)|/unlock'
  '"first run free"|first run free'
  'the $4.99 price|\$4\.99'
)
failed=0
for marker in "${MARKERS[@]}"; do
  label="${marker%%|*}"
  pattern="${marker##*|}"
  hits="$(grep -rIl -i -E "$pattern" "$WORK/x" || true)"
  if [ -n "$hits" ]; then
    failed=1
    echo "  PRESENT (must be absent) · $label" >&2
    printf '%s\n' "$hits" | sed "s|^$WORK/x/|    in |" >&2
  else
    echo "  absent · $label"
  fi
done

# Reported, never fatal: these words are legitimate in an app ("the store you bought
# it from", the game's own use of "unlock" in unrelated copy).
for word in stripe unlock; do
  # `|| true` INSIDE the braces on purpose: grep exits 1 when it finds nothing, and
  # with `set -o pipefail` that would abort the script at exactly the wrong moment
  # (the healthy case).
  count="$({ grep -rIo -i -E "$word" "$WORK/x" 2>/dev/null || true; } | wc -l | tr -d ' ')"
  echo "  advisory (not fatal) · the word \"$word\" appears ${count}×"
done

# ---- 3b. the edition's own wording, inside the same unzipped bundle ----------------
# The check that matters most for the Play upload: this bundle's web files must say
# the app is FREE and must never say it is paid, because the Play listing will be
# free and Google will not let that be undone. Same rules, same phrases and same
# failure text as the store guard that runs on dist/ — one implementation, in
# tools/store-edition-rules.mjs, so this cannot quietly disagree with it.
echo "  -- store edition wording --"
if ! bun "$SCRIPT_DIR/store-edition-check.mjs" "$WORK/x" "$EDITION"; then
  echo "aab-content-guard: FAIL — the wrong store edition's wording is inside this bundle." >&2
  echo "  Do not upload it. Rebuild with STORE_PLATFORM=$EDITION (the Android workflow sets" >&2
  echo "  STORE_PLATFORM=android) so 'bun run store:www' assembles www-store/ for this store," >&2
  echo "  then run 'npx cap sync android' so those files — not an earlier edition's — are the" >&2
  echo "  ones Gradle packs." >&2
  exit 1
fi

# ---- 4. the app's pages must be able to reach the game's server ---------------------
if [ -n "$EXPECTED_API_BASE" ]; then
  if grep -rIl -F "$EXPECTED_API_BASE" "$WORK/x" >/dev/null 2>&1; then
    echo "  ok: the bundle addresses the API absolutely at $EXPECTED_API_BASE (the boards will work inside the app)"
  else
    echo "aab-content-guard: FAIL — the bundle never names $EXPECTED_API_BASE." >&2
    echo "  The app's pages are local files on the app's own origin, so a relative /api/…" >&2
    echo "  call would go to the app itself and the boards, profiles and counters would be" >&2
    echo "  dead inside it while looking healthy in a browser. See src/lib/api-base.ts." >&2
    exit 1
  fi
fi

# ---- 5. our launcher icon should be in there (advisory) -----------------------------
# Advisory on purpose: Gradle/AAPT2 may re-encode or rename resource entries inside a
# bundle, so a byte-level claim here would be a claim this script cannot stand behind.
# The icon is asserted on the project's own files before the build, which is where it
# can be checked exactly (see tools/android-icons.py verify).
icons="$(find "$WORK/x/base/res" -type f -name 'ic_launcher*.png' 2>/dev/null | wc -l | tr -d ' ')"
if [ "$icons" -ge 15 ]; then
  echo "  advisory · $icons ic_launcher*.png resource files are in the bundle (15 expected: 5 densities × square/round/foreground)"
else
  echo "  advisory · only $icons ic_launcher*.png resource files are in the bundle; 15 were expected."
  echo "             Read the 'Install the launcher icons' step's log before uploading."
fi

if [ "$failed" != 0 ]; then
  cat >&2 <<'MSG'

aab-content-guard: FAIL — a web purchase surface is inside this Android bundle.

  The .aab that Gradle just built contains web files WITH the web shop in them, which
  means the guarded store build did not make it into android/app/src/main/assets/public/.
  Do not upload this bundle: the Play listing is a free app, so a price, a buy link or
  a free-first-run promise inside it describes something that does not exist, and Play
  would look at a paid-download checkout steering anyone to an outside payment
  (https://support.google.com/googleplay/android-developer/answer/9858738).

  The usual cause is a `www-store/` (or an assets/public/) left over from an earlier
  run. Re-run the job so `bun run store:www` rebuilds it from source before Gradle
  packs it.
MSG
  exit 1
fi

echo
echo "aab-content-guard: PASS — the web assets inside this bundle are the guarded STORE build,"
echo "  of the $EDITION edition:"
echo "  no payment link, no /unlock route, no \"first run free\" wording, no price,"
if [ "$EDITION" = "android" ]; then
  echo "  and the app's own pages say it is free: no \"paid app\" anywhere in it."
else
  echo "  and the app's own pages say it is a paid download, as the App Store build requires."
fi
