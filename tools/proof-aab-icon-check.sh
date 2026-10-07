#!/usr/bin/env bash
# =====================================================================================
#  Proof harness for the AAB launcher-icon check
#  (tools/aab-independent-verify.sh section 5 + tools/aab-icon-visible-diff.py)
# =====================================================================================
#
#  WHAT IS BEING PROVED. That the icon check in the independent verifier accepts a
#  correctly-iconed bundle and REFUSES a bundle wearing the wrong artwork — and that it
#  does so on VISIBLE pixels, not on bytes aapt2 happened to rewrite. Both directions
#  matter: a check that fails everything is as useless as one that passes everything.
#
#  The three cases, run against real artifacts (never a synthetic zip):
#
#   1. the real 2026-10-07 release-candidate .aab, downloaded from the green Android
#      run and kept in /home/team/shared/artifacts/        → PASS, 15/15 icons
#                                                            visibly identical, 0
#                                                            placeholder files
#   2. the SAME bundle with ONE launcher icon swapped for a genuine Capacitor /
#      Android Studio template placeholder (a real file from @capacitor/android, kept
#      in tools/fixtures/ so this runs offline)             → FAIL, loudly, naming the
#                                                            file it found
#   3. the SAME bundle with one icon replaced by a valid but WRONG icon (our mdpi
#      artwork copied over the hdpi slot)                   → FAIL, on size AND pixels
#
#  Every doctored copy lives under $WORK (/tmp) — the signed bundle is never touched,
#  and the harness refuses to run if the artifact is not where it expects it.
#
#    bash tools/proof-aab-icon-check.sh
#    AAB=/path/to.aab  WORK=/some/scratch  SITE=/path/to/site  bash tools/proof-aab-icon-check.sh
#
#  The harness prints one result line per assertion and a final summary line; it exits
#  non-zero if any assertion failed.
# =====================================================================================
set -uo pipefail

SITE="${SITE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
AAB="${AAB:-/home/team/shared/artifacts/android-release-2026-10-07/app-release-vc1-run37642747373.aab}"
WORK="${WORK:-/tmp/gi-aab-icon-proof}"
VERIFY="$SITE/tools/aab-independent-verify.sh"
FIXTURES="$SITE/tools/fixtures/capacitor-template-icons"

fails=0
passes=0
ok()  { printf '  PASS  %s\n' "$1"; passes=$((passes + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; fails=$((fails + 1)); }

expect() { # description, haystack-file, pattern
  local what="$1" file="$2" pattern="$3"
  if grep -qF -- "$pattern" "$file"; then
    ok "$what"
  else
    bad "$what — expected to find: $pattern"
    echo "        (last 12 lines of $file:)"
    tail -12 "$file" | sed 's/^/        /'
  fi
}

rm -rf "$WORK"; mkdir -p "$WORK"
cd / || exit 2
[ -f "$AAB" ] || { echo "cannot find the artifact at $AAB"; exit 2; }
[ -f "$VERIFY" ] || { echo "cannot find the verifier at $VERIFY"; exit 2; }
[ -d "$FIXTURES" ] || { echo "cannot find the placeholder fixtures at $FIXTURES"; exit 2; }

echo "artifact under test: $AAB"
echo "  sha256 $(sha256sum "$AAB" | cut -d' ' -f1)"
echo "  scratch $WORK"

# -------------------------------------------------------------------------------------
# doctoring: rewrite ONE entry inside a copy of the bundle. The original is never opened
# for writing; the copy is a zip aapt2 never signed, which is fine — this harness proves
# the icon check, and the signature is section 7's business, not this one's.
# -------------------------------------------------------------------------------------
doctor() { # src dst member replacement
  python3 - "$1" "$2" "$3" "$4" <<'PY'
import sys, zipfile
from pathlib import Path
src, dst, member, replacement = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
payload = Path(replacement).read_bytes()
zin = zipfile.ZipFile(src)
names = zin.namelist()
if member not in names:
    raise SystemExit(f"no such entry in the bundle: {member}")
with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
    for item in zin.infolist():
        zout.writestr(item, payload if item.filename == member else zin.read(item.filename))
print(f"doctored: {member} <- {replacement} ({len(payload)} bytes) in {Path(dst).name}")
PY
}

echo
echo "case 1 — the real release-candidate bundle must PASS"
OUT1="$WORK/real.txt"
bash "$VERIFY" "$AAB" proof-real > "$OUT1" 2>&1
RC1=$?
[ "$RC1" = 0 ] && ok "the verifier exits 0 on the real bundle" \
               || bad "the verifier exited $RC1 on the real bundle (must be 0)"
expect "all 15 icons are visibly identical" "$OUT1" \
  "-- composited-over-white-and-black identical for 15/15 files (visible differences: 0)"
expect "the icon check's own summary agrees" "$OUT1" \
  "-- visible-identical: 15  visibly-different: 0  missing: 0"
expect "no placeholder launcher image is in the bundle" "$OUT1" \
  "placeholder files found in the bundle: 0 (must be 0)"
expect "the verdict line is a PASS" "$OUT1" "VERDICT: PASS"
expect "the re-encode is reported as an annotation, not as a wrong icon" "$OUT1" \
  "re-encoded by aapt2"
# The raw-byte result must still be visible somewhere — that is the honesty half of the
# change: a real byte change is annotated, never hidden.
expect "the raw-byte result is still reported (as an advisory)" "$OUT1" \
  "advisory (raw bytes, not a verdict)"
if grep -q "VISIBLE-DIFFERENT" "$OUT1"; then
  bad "a real bundle reported VISIBLE-DIFFERENT"
else
  ok "not one VISIBLE-DIFFERENT line on the real bundle"
fi

echo
echo "case 2 — one launcher icon swapped for a genuine Capacitor placeholder must FAIL"
DOC1="$WORK/placeholder.aab"
doctor "$AAB" "$DOC1" "base/res/mipmap-mdpi-v4/ic_launcher.png" \
       "$FIXTURES/ic_launcher-mdpi.png" > "$WORK/doctor1.txt" 2>&1
cat "$WORK/doctor1.txt"
OUT2="$WORK/placeholder.txt"
bash "$VERIFY" "$DOC1" proof-placeholder > "$OUT2" 2>&1
RC2=$?
[ "$RC2" != 0 ] && ok "the verifier exits non-zero ($RC2) on a bundle wearing the placeholder" \
                || bad "the verifier exited 0 on a bundle whose launcher icon is the Capacitor placeholder"
expect "the naming-free placeholder test caught it" "$OUT2" \
  "!! PLACEHOLDER INSIDE THE BUNDLE: base/res/mipmap-mdpi-v4/ic_launcher.png"
expect "and it named the file in plain words" "$OUT2" "placeholder files found in the bundle: 1"
expect "the pixel check flagged the same file" "$OUT2" "VISIBLE-DIFFERENT  mipmap-mdpi/ic_launcher.png"
expect "the failure is named in the summary" "$OUT2" "is NOT our icon (or is not there at all)"
expect "the verdict line is a FAIL" "$OUT2" "VERDICT: FAIL"
grep -q "VERDICT: PASS" "$OUT2" && bad "it also printed a PASS verdict" || ok "no PASS verdict anywhere in that run"

echo
echo "case 3 — one icon replaced by a valid but WRONG icon (mdpi artwork in the hdpi slot) must FAIL"
DOC2="$WORK/wrong-icon.aab"
# Our own rendered icon set, produced here and now by the repository's icon tool — the
# hdpi slot gets the mdpi artwork, i.e. a valid PNG of the wrong size and the wrong image.
mkdir -p "$WORK/expected"
( cd "$SITE" && python3 tools/android-icons.py install "$WORK/expected" ) > "$WORK/expected-gen.txt" 2>&1
doctor "$AAB" "$DOC2" "base/res/mipmap-hdpi-v4/ic_launcher.png" \
       "$WORK/expected/mipmap-mdpi/ic_launcher.png" > "$WORK/doctor2.txt" 2>&1
cat "$WORK/doctor2.txt"
OUT3="$WORK/wrong-icon.txt"
bash "$VERIFY" "$DOC2" proof-wrong-icon > "$OUT3" 2>&1
RC3=$?
[ "$RC3" != 0 ] && ok "the verifier exits non-zero ($RC3) on a bundle with the wrong artwork" \
                || bad "the verifier exited 0 with our mdpi artwork sitting in the hdpi slot"
expect "it fails on SIZE first" "$OUT3" "size differs — the bundle has 48×48, ours is 72×72"
expect "and names the file it failed on" "$OUT3" "VISIBLE-DIFFERENT  mipmap-hdpi/ic_launcher.png"
expect "the verdict line is a FAIL" "$OUT3" "VERDICT: FAIL"
# The same doctoring is a real pixel difference too: prove the check is not only
# measuring dimensions, by comparing 48×48 against 48×48 with different artwork.
echo
echo "case 3b — same-size but different artwork must fail on PIXELS (not just on size)"
# Our mdpi artwork vs the template's mdpi placeholder: both 48×48, entirely different
# images. This is the case a dimension check alone would wave through.
rm -rf "$WORK/pixcmp" "$WORK/pixexp"
mkdir -p "$WORK/pixcmp/mipmap-mdpi" "$WORK/pixexp/mipmap-mdpi"
cp "$WORK/expected/mipmap-mdpi/ic_launcher.png" "$WORK/pixcmp/mipmap-mdpi/ic_launcher.png"
cp "$FIXTURES/ic_launcher-mdpi.png" "$WORK/pixexp/mipmap-mdpi/ic_launcher.png"
OUT3B="$WORK/wrong-pixels.txt"
python3 "$SITE/tools/aab-icon-visible-diff.py" \
  --bundle-root "$WORK/pixcmp" --expected "$WORK/pixexp" \
  --icons-tool "$SITE/tools/android-icons.py" > "$OUT3B" 2>&1
RC3B=$?
[ "$RC3B" != 0 ] && ok "identical dimensions, different artwork → the pixel check fails ($RC3B)" \
                || bad "two different 48×48 icons compared as identical"
expect "the pixel failure reports visible pixels over white and black" "$OUT3B" "visible pixel(s) over white"
expect "it says the file is not our icon" "$OUT3B" "is NOT our icon (or is not there at all)"

echo
echo "--------------------------------------------------------------"
echo "aab icon check proof: $passes passed, $fails failed"
echo "proof line: real 2026-10-07 bundle → PASS (15/15 visible-identical, 0 placeholders) ·" \
     "Capacitor placeholder → FAIL · wrong-size artwork → FAIL · same-size wrong artwork → FAIL"
echo "transcripts kept in $WORK (real.txt, placeholder.txt, wrong-icon.txt, wrong-pixels.txt)"
[ "$fails" = 0 ] || exit 1
