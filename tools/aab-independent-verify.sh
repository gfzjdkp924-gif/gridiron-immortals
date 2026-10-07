#!/usr/bin/env bash
# =====================================================================================
#  Independent verification of a downloaded .aab against a run's claims
# =====================================================================================
#
#  Deliberately NOT a re-run of the workflow's own assertions: this reads the artifact
#  with its own tools (its own protobuf manifest reader, bundletool as a second
#  unrelated reader, unzip, jarsigner/keytool, and a pixel comparison of the launcher
#  icon) so that "the build said it was fine" is never the evidence.
#
#  Usage:  bash tools/aab-independent-verify.sh <path-to-aab> [run-id]
#
#  Environment (all optional):
#    SITE=/path/to/site        the repository root — defaults to this script's parent
#    API_BASE=https://…/api    the server address the bundle's pages must name
#    OUT=/scratch/out-<run>    where the unpacked bundle and transcripts go
#                              (default /tmp/aab-verify/out-<run>: /home is a small volume)
#    BUNDLETOOL=/path/to.jar   a second, unrelated manifest reader; if absent that
#                              section says so and is skipped (it is supplementary —
#                              section 3 reads the manifest without it)
#    PLACEHOLDER_DIR=…         a Capacitor/Android-Studio template res/ tree to cross-check
#                              the placeholder md5 list against (optional)
#
#  EXIT CODE. 0 only when the content guard accepted the bundle AND every launcher icon
#  in it is visibly the artwork our generator produces. A visibly different (or missing)
#  icon, or a guard refusal, exits 1. This is the whole point of the icon section below:
#  aapt2 re-encodes PNGs, so a raw-byte comparison cannot tell "aapt2 touched it" from
#  "the wrong icon is in there" — the check is therefore made on VISIBLE pixels, with
#  the raw-byte result kept as an annotation so a real byte change is never hidden.
#
#  The icon rule in one line: a bundle icon must be present, the right size, and
#  identical to our generated twin after compositing both over WHITE and over BLACK.
# =====================================================================================
set -uo pipefail

AAB="${1:?usage: aab-independent-verify.sh <aab> [run-id]}"
RUN="${2:-unknown}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SITE="${SITE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
API_BASE="${API_BASE:-https://www.gridironimmortals.com/api}"
OUT="${OUT:-/tmp/aab-verify/out-$RUN}"
ICON_TOOL="$SITE/tools/aab-icon-visible-diff.py"
GUARD="$SITE/tools/aab-content-guard.sh"
rm -rf "$OUT"; mkdir -p "$OUT"

# A second manifest reader, if one is available. Supplementary: its absence is reported,
# never silently ignored.
BUNDLETOOL="${BUNDLETOOL:-}"
if [ -z "$BUNDLETOOL" ]; then
  for c in "$SITE/tools/bundletool.jar" /tmp/eng/bundletool.jar; do
    [ -f "$c" ] && BUNDLETOOL="$c" && break
  done
fi

FAILS=0
hr(){ printf '\n===== %s =====\n' "$1"; }

hr "0. the file itself"
if [ ! -f "$AAB" ]; then echo "!! no such file: $AAB"; exit 2; fi
ls -l "$AAB"
echo "sha256: $(sha256sum "$AAB" | cut -d' ' -f1)"
echo "bytes : $(stat -c%s "$AAB")"
file "$AAB"
echo "site  : $SITE"
echo "scratch: $OUT"

hr "1. the AAB content guard (edition + purchase surface + api base)"
if [ -f "$GUARD" ]; then
  ( cd "$SITE" && bash "$GUARD" "$AAB" "$API_BASE" android ) > "$OUT/guard.txt" 2>&1
  GRC=$?
  cat "$OUT/guard.txt"
  echo "guard exit: $GRC"
  if [ "$GRC" != 0 ]; then
    FAILS=$((FAILS+1))
    echo "NOTE: a non-zero guard exit is a REFUSAL and is counted as a failure here, not"
    echo "      smoothed over. If the PASS banner is absent as well, the refusal came from"
    echo "      the guard's icon-advisory block rather than from a purchase surface; the"
    echo "      last line it printed says which."
  fi
else
  FAILS=$((FAILS+1))
  echo "!! the content guard is missing at $GUARD — the bundle's web assets are UNCHECKED"
fi

hr "2. unzip integrity + top-level layout"
unzip -t "$AAB" | tail -2
unzip -l "$AAB" > "$OUT/entries.txt"
awk '{print $4}' "$OUT/entries.txt" | grep -v '^$' | awk -F/ '{print $1}' | sort | uniq -c | sort -rn | head -15

hr "3. manifest — this script's own protobuf reader (no aapt2 on this box)"
READER="$SITE/tools/aab_manifest.py"
if [ -f "$READER" ]; then
  python3 "$READER" "$AAB" > "$OUT/manifest.mine.txt" 2>&1
  grep -iE '<manifest>|package|versionCode|versionName|targetSdkVersion|minSdkVersion|icon|debuggable|uses-sdk' "$OUT/manifest.mine.txt" | head -30
else
  echo "!! no manifest reader at $READER"
  FAILS=$((FAILS+1))
fi

hr "4. manifest — bundletool (second, unrelated reader)"
if [ -n "$BUNDLETOOL" ] && [ -f "$BUNDLETOOL" ] && command -v java >/dev/null; then
  java -Xmx320m -jar "$BUNDLETOOL" dump manifest --bundle="$AAB" > "$OUT/manifest.bundletool.xml" 2>"$OUT/bundletool.err"
  echo "bundletool exit: $?"
  if [ -s "$OUT/manifest.bundletool.xml" ]; then
    head -c 1200 "$OUT/manifest.bundletool.xml"; echo
    grep -oE 'package="[^"]*"|versionCode="[^"]*"|versionName="[^"]*"|targetSdkVersion="[^"]*"|minSdkVersion="[^"]*"' "$OUT/manifest.bundletool.xml"
  else
    tail -5 "$OUT/bundletool.err"
  fi
else
  echo "-- SKIPPED: no bundletool at ${BUNDLETOOL:-<none found>} (or no java). This section"
  echo "   is a second opinion, not the check: section 3 already read the manifest."
fi

# -------------------------------------------------------------------------------------
hr "5. the icon that is really inside the bundle — compared on VISIBLE pixels"
# The generated twin set is rendered HERE AND NOW by the repository's own icon tool, so
# this section compares the bundle against what our source artwork produces today, not
# against a set someone stashed in /tmp earlier.
GEN="$OUT/expected"
rm -rf "$GEN"; mkdir -p "$GEN"
if ( cd "$SITE" && python3 tools/android-icons.py install "$GEN" ) > "$OUT/expected-gen.txt" 2>&1; then
  echo "-- our generated twin set: $(find "$GEN" -name '*.png' | wc -l) PNGs rendered by $SITE/tools/android-icons.py"
else
  echo "!! could not render the expected icon set — this section cannot conclude anything:"
  sed 's/^/     /' "$OUT/expected-gen.txt"
  FAILS=$((FAILS+1))
fi

rm -rf "$OUT/x"; mkdir -p "$OUT/x"
( cd "$OUT/x" && unzip -q "$AAB" )
echo "-- ic_launcher*.png / *.xml as aapt2 actually wrote them (note the -v4 qualifier it adds):"
find "$OUT/x" -name 'ic_launcher*' -type f | sed "s|$OUT/x/||" | sort | sed 's/^/     /'

ICON_RC=0
if [ -f "$ICON_TOOL" ] && [ -d "$GEN" ]; then
  echo "-- per file: our generated twin vs the bundle's, composited over WHITE and over BLACK"
  echo "   (a visible difference is a FAILURE; the raw-byte result is the annotation in brackets,"
  echo "    so an aapt2 re-encode is named honestly instead of reading as a wrong icon):"
  python3 "$ICON_TOOL" --bundle-root "$OUT/x" --expected "$GEN" \
      --icons-tool "$SITE/tools/android-icons.py" | tee "$OUT/icon-visible.txt"
  ICON_RC="${PIPESTATUS[0]}"
  echo "icon pixel check exit: $ICON_RC   (0 = every icon visibly ours)"
  # Keep the raw-byte result as its own advisory line as well, so the count is visible
  # even when every re-encode was benign.
  raw_exact=$(grep -c '(byte-identical)' "$OUT/icon-visible.txt" || true)
  echo "-- advisory (raw bytes, not a verdict): $raw_exact of 18 icon-set files are exact"
  echo "   md5 twins of ours; the rest were re-encoded by aapt2 — see each file's annotation"
  echo "   above. The 2 mipmap-anydpi-v26/*.xml files are expected to 'differ' because"
  echo "   aapt2 compiles XML to binary, which is what the earlier UNMATCHED lines meant."
  if [ "$ICON_RC" != 0 ]; then
    FAILS=$((FAILS+1))
    echo "!! ICON CHECK FAILED — the bundle's launcher icon is not visibly our artwork."
  fi
else
  echo "!! cannot run the pixel comparison (helper: $ICON_TOOL)"
  FAILS=$((FAILS+1))
fi

echo "-- and the same test without any naming assumption: is any file in the bundle a"
echo "   byte-identical twin of a Capacitor / Android Studio placeholder launcher image?"
python3 - "$SITE/tools/android-icons.py" "$OUT/placeholder-md5.txt" "$SITE/tools/fixtures" <<'PY'
import importlib.util, subprocess, sys
from pathlib import Path
sys.dont_write_bytecode = True  # never litter tools/ with __pycache__
tool, dest, fixtures = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
known = {}
if tool.is_file():
    spec = importlib.util.spec_from_file_location("gi_android_icons", tool)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    known.update(module.PLACEHOLDER_MD5)
if fixtures.is_dir():
    for p in sorted(fixtures.rglob("*.png")):
        known.setdefault(subprocess.run(["md5sum", str(p)], capture_output=True, text=True
                                        ).stdout.split()[0], f"fixture {p.name}")
dest.write_text("".join(f"{h}  {w}\n" for h, w in sorted(known.items())))
print(f"   ({len(known)} placeholder md5s known: read out of the icon tool's own"
      " PLACEHOLDER_MD5 table)")
PY
if [ -s "$OUT/placeholder-md5.txt" ]; then
  python3 - "$OUT/x" "$OUT/placeholder-md5.txt" <<'PY'
import hashlib, sys
from pathlib import Path
root, listing = Path(sys.argv[1]), Path(sys.argv[2])
known = {}
for line in listing.read_text().splitlines():
    h, _, where = line.partition("  ")
    known[h] = where
hits = 0
for path in sorted(root.rglob("*")):
    if not path.is_file():
        continue
    md5 = hashlib.md5(path.read_bytes()).hexdigest()
    if md5 in known:
        print(f"  !! PLACEHOLDER INSIDE THE BUNDLE: {path.relative_to(root)} (md5 {md5}, {known[md5]})")
        hits += 1
print(f"  placeholder files found in the bundle: {hits} (must be 0)")
sys.exit(1 if hits else 0)
PY
  PLACEHOLDER_RC=$?
  if [ "$PLACEHOLDER_RC" != 0 ]; then
    FAILS=$((FAILS+1))
    echo "!! a placeholder launcher image is inside this bundle — the app would wear Android"
    echo "   Studio's default artwork."
  fi
else
  FAILS=$((FAILS+1))
  echo "!! could not build the placeholder md5 list — the naming-free test did not run"
fi

hr "6. the web app inside (assets/public)"
PUB=$(find "$OUT/x" -type d -path '*/assets/public' 2>/dev/null | head -1)/index.html
[ -f "$PUB" ] || PUB=""
echo "-- ic_launcher*.png resource files anywhere in the bundle: $(find "$OUT/x" -name 'ic_launcher*.png' | wc -l)"
echo "index.html: ${PUB:-MISSING}"
if [ -n "$PUB" ]; then
  echo "files under assets/public: $(find "$(dirname "$PUB")" -type f | wc -l)"
  grep -oE 'https://[a-z0-9.]*gridironimmortals[^"'"'"' ]*' "$(dirname "$PUB")"/*.html 2>/dev/null | sort -u | head -5
  echo "-- purchase markers in the bundle's text files (should be none):"
  grep -rIl -e 'buy.stripe.com' -e 'first run free' -e '\$4\.99' -e '/unlock' "$OUT/x" 2>/dev/null | head -10
  echo "-- free-edition wording present in the bundle:"
  grep -rIoh -e 'free' "$(dirname "$PUB")" 2>/dev/null | wc -l
fi

hr "7. the signature (jarsigner v1 over the whole bundle)"
jarsigner -verify -verbose:summary -certs "$AAB" 2>&1 | tail -25
echo "-- signer certificate (public, no private material):"
keytool -printcert -jarfile "$AAB" 2>/dev/null | grep -E 'Owner|Issuer|Valid from|Signature algorithm|SHA256with' | head -12
echo "-- is this the well-known Android DEBUG key? (must NOT be)"
if keytool -printcert -jarfile "$AAB" 2>/dev/null | grep -q 'CN=Android Debug'; then echo "  !! DEBUG KEY"; else echo "  ok: not the Android Debug key"; fi

hr "8. version/sdk numbers read twice, by the two readers"
echo "bundletool: $(grep -oE 'versionCode="[0-9]*"|versionName="[^"]*"|targetSdkVersion="[0-9]*"|minSdkVersion="[0-9]*"' "$OUT/manifest.bundletool.xml" 2>/dev/null | tr '\n' ' ')"
echo "mine      : $(grep -oE 'versionCode = [0-9]+|versionName = .*|targetSdkVersion = [0-9]+|minSdkVersion = [0-9]+' "$OUT/manifest.mine.txt" 2>/dev/null | tr '\n' ' ')"

hr "9. verdict"
echo "icon pixel check exit: $ICON_RC (0 = every launcher icon visibly ours)"
echo "failures counted     : $FAILS"
echo "artifacts kept in $OUT"
if [ "$FAILS" -eq 0 ]; then
  echo "VERDICT: PASS — the guard accepted the bundle and every launcher icon in it is visibly our artwork"
  exit 0
fi
echo "VERDICT: FAIL — $FAILS check group(s) failed; see the !! lines above"
exit 1
