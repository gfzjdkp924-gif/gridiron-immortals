#!/usr/bin/env bash
# =====================================================================================
#  proof-android-secret-extraction.sh — the fixture proof for the signing-material guard
#  in tools/github-bootstrap.sh.
#
#  WHAT IT PROVES, and why it is written this way. On 2026-10-05 two Android secrets
#  reached GitHub carrying the annotation column of /home/team/shared/secrets/
#  README-keystore.txt (a 41-character alias, a 57-character key password), and the CI
#  run stopped with `keytool error: … Alias <…> does not exist`. This harness runs the
#  SHIPPED code — the guard block extracted verbatim from tools/github-bootstrap.sh, and
#  the real --set-secrets entry point in --dry-run — against synthetic READMEs built from
#  the real values, and checks both directions:
#
#    PASS   an annotated line (today's shape), a bare line, and a padded line all extract
#           to the right values and reach the upload step (four `gh secret set` calls)
#    REFUSE a wrong alias, an alias column holding only its annotation, a wrong key
#           password of the CORRECT length, a tampered keystore and a wrong-length store
#           password each stop BEFORE any upload, name the secret, and exit non-zero
#
#  SAFETY. No token is needed and `gh` is never called (--dry-run prints the command it
#  would run). No secret value is printed and none is stored in this file or in the
#  fixtures' names: the fixtures are built at run time by reading the real README through
#  the script's own extractor, and every message below prints LENGTHS and md5s only. The
#  fixtures live in a temp directory that is deleted on exit.
#
#  USAGE  bash tools/proof-android-secret-extraction.sh          (from the repo root)
#         the exit status is the number of failed expectations, 0 meaning all passed.
# =====================================================================================
set -uo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd -- "$HERE/.." && pwd)
BOOTSTRAP="$ROOT/tools/github-bootstrap.sh"
REAL_README=${BOOTSTRAP_KEYSTORE_README:-/home/team/shared/secrets/README-keystore.txt}
REAL_KEYSTORE=${BOOTSTRAP_KEYSTORE_FILE:-/home/team/shared/secrets/android-upload-key.jks}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/gi-secret-proof.XXXXXX")
trap 'rm -rf -- "$WORK"' EXIT

FAILED=0
EX=0
step() { EX=$((EX + 1)); printf '\n=== %s. %s\n' "$EX" "$1"; }
check() { # check <ok:0|1> <description>
  if [ "$1" -eq 0 ]; then printf '  [ok]   %s\n' "$2"; else printf '  [NO]   %s\n' "$2"; FAILED=$((FAILED + 1)); fi
}

for f in "$BOOTSTRAP" "$REAL_README" "$REAL_KEYSTORE"; do
  [ -r "$f" ] || { printf 'cannot read %s\n' "$f" >&2; exit 2; }
done

# ------------------------------------------------------------------ 1. extract the guard
step "the shipped guard block is cut out of tools/github-bootstrap.sh verbatim"
sed -n '/SIGNING-MATERIAL GUARD — BEGIN/,/SIGNING-MATERIAL GUARD — END/p' "$BOOTSTRAP" >"$WORK/guard.sh"
GUARD_LINES=$(grep -c . "$WORK/guard.sh")
printf '  guard block: %s lines, sha256 %s\n' "$GUARD_LINES" "$(sha256sum "$WORK/guard.sh" | awk '{print $1}')"
check "$([ "$GUARD_LINES" -gt 100 ] && echo 0 || echo 1)" "the block is non-empty ($GUARD_LINES lines)"
check "$(grep -q '^verify_signing_material() {' "$WORK/guard.sh" && echo 0 || echo 1)" "the block defines verify_signing_material()"
check "$(grep -q '^readme_value() {' "$WORK/guard.sh" && echo 0 || echo 1)" "the block defines readme_value()"

# The guard calls this script's own pass/fail/note/skip + $RESULTS_FILE. Same semantics.
RESULTS_FILE="$WORK/results"
record() { printf '%s|%s|%s\n' "$1" "$2" "$3" >>"$RESULTS_FILE"; }
pass()  { record PASS "$1" "${2:-}"; printf '  [PASS] %s\n' "$1"; }
fail()  { record FAIL "$1" "${2:-}"; printf '  [FAIL] %s\n' "$1"; }
note()  { record NOTE "$1" "${2:-}"; printf '  [note] %s\n' "$1"; }
skip()  { record SKIP "$1" "${2:-}"; printf '  [skip] %s\n' "$1"; }
KEYSTORE_FILE="$REAL_KEYSTORE"
KEYSTORE_README="$REAL_README"
# shellcheck source=/dev/null
. "$WORK/guard.sh"

# --------------------------------------------------- 2. the real values, by length only
step "the real README's three values, read through the shipped extractor (lengths only)"
SPW=$(secret_value_store_password)
ALIAS=$(secret_value_key_alias)
KPW=$(secret_value_key_password)
printf '  store password  %2s chars (the README says 28)\n' "${#SPW}"
printf '  key alias       %2s chars (the keystore has one entry, 15 chars)\n' "${#ALIAS}"
printf '  key password    %2s chars (the same value as the store password)\n' "${#KPW}"
check "$([ "${#SPW}" -eq 28 ] && echo 0 || echo 1)" "the store password extracts to 28 characters"
check "$([ "${#ALIAS}" -eq 15 ] && echo 0 || echo 1)" "the alias extracts to 15 characters"
check "$([ "${#KPW}" -eq 28 ] && echo 0 || echo 1)" "the key password extracts to 28 characters"

# ------------------------------------------- 3. what the OLD extractors would have sent
step "regression: the extractors that shipped the bug, run on today's annotated line"
OLD_ALIAS_LEN=$(printf '  key alias          %s      -> ANDROID_KEY_ALIAS\n' "$ALIAS" \
  | sed -n 's/^  key alias *//p' | head -1 | wc -c)
OLD_KPW_LEN=$(printf '  key password       %s      -> ANDROID_KEY_PASSWORD   (same value as the store password)\n' "$KPW" \
  | sed -n 's/^  key password *//p' | head -1 | sed 's/ *(same value.*$//' | sed 's/ *$//' | wc -c)
printf '  old extractor on that line: alias %s chars (wc -c, includes the newline), key password %s\n' \
  "$OLD_ALIAS_LEN" "$OLD_KPW_LEN"
printf '  new extractor on that line: alias %s chars, key password %s\n' "${#ALIAS}" "${#KPW}"
check "$([ "$((OLD_ALIAS_LEN - 1))" -eq 41 ] && echo 0 || echo 1)" "the old extractor yields the 41-character alias that GitHub received"
check "$([ "${#ALIAS}" -eq 15 ] && echo 0 || echo 1)" "the new extractor yields the alias alone"

# ------------------------------------------------------- 4. fixture READMEs, built here
# Every fixture is written with the REAL values (read above) in a different shape, so the
# pass cases exercise real keytool proofs and nothing in this file is a credential.
WRONG_ALIAS=$(printf 'g%.0s' $(seq 1 15))                 # 15 chars, not the keystore's entry
BAD_KPW=$(printf 'Z%.0s' $(seq 1 28))                     # 28 chars (right length, wrong value)
LONG_SPW=$(printf 'p%.0s' $(seq 1 40))                    # 40 chars, no keystore opens with it

fx_annotated() { # today's shape: value, then `-> NAME`, then a trailing parenthetical
  cat >"$1" <<EOF
GRIDIRON IMMORTALS — ANDROID KEY (fixture: annotated lines, today's shape)
THE FOUR VALUES (and where each one goes)
  keystore file      android-upload-key.jks      -> ANDROID_KEYSTORE_BASE64 (below)
  store password     $SPW
  key alias          ${2:-$ALIAS}      -> ANDROID_KEY_ALIAS
  key password       ${3:-$KPW}      -> ANDROID_KEY_PASSWORD   (same value as the store password)
PUT THEM IN GITHUB
  ANDROID_KEY_ALIAS           ${2:-$ALIAS}
  ANDROID_KEYSTORE_PASSWORD   (the store password above)
  ANDROID_KEY_PASSWORD        (the key password above — the same value)
EOF
}
fx_bare() { # the same values with no annotation column at all
  cat >"$1" <<EOF
GRIDIRON IMMORTALS — ANDROID KEY (fixture: no annotation)
  store password  ${2:-$SPW}
  key alias  ${3:-$ALIAS}
  key password  ${4:-$KPW}
EOF
}
fx_padded() { # odd padding: tabs, long runs of spaces, trailing spaces
  cat >"$1" <<EOF
GRIDIRON IMMORTALS — ANDROID KEY (fixture: extra and irregular spacing)
  store password		${2:-$SPW}
  key alias            ${3:-$ALIAS}          -> ANDROID_KEY_ALIAS
  key password         ${4:-$KPW}   -> ANDROID_KEY_PASSWORD
EOF
}
fx_annotation_only() { # the mangled shape: the value column holds the annotation
  cat >"$1" <<EOF
GRIDIRON IMMORTALS — ANDROID KEY (fixture: alias column holds only the annotation)
  store password     $SPW
  key alias          -> ANDROID_KEY_ALIAS
  key password       $KPW      -> ANDROID_KEY_PASSWORD
EOF
}
FX="$WORK/fixtures"; mkdir -p "$FX"
fx_annotated "$FX/annotated.txt"
fx_bare "$FX/bare.txt"
fx_padded "$FX/padded.txt"
fx_annotation_only "$FX/annotation-only.txt"
fx_annotated "$FX/wrong-alias.txt" "$WRONG_ALIAS"
fx_annotated "$FX/wrong-keypw.txt" "$ALIAS" "$BAD_KPW"
fx_annotated "$FX/long-storepw.txt" "$LONG_SPW"

run_guard() { # run_guard <fixture> → sets RC and OUT
  KEYSTORE_README=$1
  RESULTS_FILE="$WORK/results.$(basename "$1")"
  : >"$RESULTS_FILE"
  if OUT=$(verify_signing_material 2>&1); then RC=0; else RC=$?; fi
}

printf '\n' >"$WORK/log.unit"
unit_expect() { # unit_expect <fixture> <pass|refuse> <secret it must name, or ->
  local name expect want wantrc
  name=$(basename "$1"); expect=$2; want=$3
  run_guard "$1"
  { printf '\n--- %s (expect %s)\n%s\n' "$name" "$expect" "$OUT"; } >>"$WORK/log.unit"
  wantrc=0; [ "$expect" = refuse ] && wantrc=1
  step "the guard on the '$name' fixture must $expect"
  check "$([ "$(( RC != wantrc ? 1 : 0 ))" -eq 0 ] && echo 0 || echo 1)" "exit status is $RC (wanted $wantrc)"
  if [ "$expect" = pass ]; then
    check "$(printf '%s' "$OUT" | grep -q 'REFUSING' && echo 1 || echo 0)" "nothing refused"
  else
    check "$(printf '%s' "$OUT" | grep -q 'REFUSING TO UPLOAD' && echo 0 || echo 1)" "it says it is refusing to upload"
    [ "$want" != "-" ] && check "$(printf '%s' "$OUT" | grep -q "$want" && echo 0 || echo 1)" "it names $want"
  fi
}
unit_expect "$FX/annotated.txt"       pass   -
unit_expect "$FX/bare.txt"            pass   -
unit_expect "$FX/padded.txt"          pass   -
unit_expect "$FX/wrong-alias.txt"     refuse ANDROID_KEY_ALIAS
unit_expect "$FX/annotation-only.txt" refuse ANDROID_KEY_ALIAS
unit_expect "$FX/wrong-keypw.txt"     refuse ANDROID_KEY_PASSWORD
unit_expect "$FX/long-storepw.txt"    refuse ANDROID_KEYSTORE_PASSWORD

# ------------------------------------------------- 5. check (d) against a tampered file
step "(d) the base64 alignment check refuses a keystore that is not this file"
cp "$REAL_KEYSTORE" "$WORK/tampered.jks"
printf 'X' | dd of="$WORK/tampered.jks" bs=1 seek=1200 conv=notrunc status=none
REAL_B64=$(secret_value_keystore_b64)
KEYSTORE_FILE="$WORK/tampered.jks"
if keystore_b64_alignment "$REAL_B64"; then TAMPER_RC=0; else TAMPER_RC=$?; fi
printf '  real .jks md5     %s\n' "$B64_MD5_LOCAL"
printf '  what the uploaded base64 decodes to  %s\n' "$B64_MD5_DECODED"
check "$([ "$TAMPER_RC" -ne 0 ] && echo 0 || echo 1)" "a base64 that decodes to a different file than $KEYSTORE_FILE is refused (rc=$TAMPER_RC)"
KEYSTORE_FILE="$REAL_KEYSTORE"
if keystore_b64_alignment "$REAL_B64"; then GOOD_RC=0; else GOOD_RC=$?; fi
check "$([ "$GOOD_RC" -eq 0 ] && echo 0 || echo 1)" "the real base64 still passes (md5 $B64_MD5_DECODED)"

# ------------------------------- 6. the real entry point, --dry-run, on both directions
# This is the end-to-end assertion: the shipped --set-secrets either reaches the upload
# step (four `gh secret set` lines) or stops before it. `gh` is never called: DRY=1 makes
# run() print the command instead.
step "the real --set-secrets entry point, in --dry-run, on each fixture"
entry_expect() { # entry_expect <fixture> <pass|refuse> <secret it must name, or ->
  local name expect want wantrc n
  name=$(basename "$1"); expect=$2; want=$3
  wantrc=0; [ "$expect" = refuse ] && wantrc=1
  if OUT=$(GH_TOKEN=fixture-dry-run-token BOOTSTRAP_KEYSTORE_README="$1" \
             bash "$BOOTSTRAP" --dry-run --set-secrets 2>&1); then RC=0; else RC=$?; fi
  n=$(printf '%s' "$OUT" | grep -c 'gh secret set' || true)
  { printf '\n--- %s (expect %s)\n%s\n' "$name" "$expect" "$OUT"; } >>"$WORK/log.entry"
  step "--set-secrets --dry-run on '$name' must $expect"
  check "$([ "$RC" -eq "$wantrc" ] && echo 0 || echo 1)" "exit status is $RC (wanted $wantrc)"
  if [ "$expect" = pass ]; then
    check "$([ "${n:-0}" -eq 4 ] && echo 0 || echo 1)" "it reaches the upload step with four gh secret set commands (saw ${n:-0})"
  else
    check "$([ "${n:-0}" -eq 0 ] && echo 0 || echo 1)" "it never reaches the upload step (saw ${n:-0} gh secret set commands)"
    [ "$want" != "-" ] && check "$(printf '%s' "$OUT" | grep -q "$want" && echo 0 || echo 1)" "it names $want"
  fi
}
entry_expect "$FX/annotated.txt"       pass   -
entry_expect "$FX/bare.txt"            pass   -
entry_expect "$FX/padded.txt"          pass   -
entry_expect "$FX/wrong-alias.txt"     refuse ANDROID_KEY_ALIAS
entry_expect "$FX/annotation-only.txt" refuse ANDROID_KEY_ALIAS
entry_expect "$FX/wrong-keypw.txt"     refuse ANDROID_KEY_PASSWORD
entry_expect "$FX/long-storepw.txt"    refuse ANDROID_KEYSTORE_PASSWORD

# ------------------------------------- 7. the real README still passes (nothing regressed)
step "the real README, through the real entry point"
if OUT=$(GH_TOKEN=fixture-dry-run-token bash "$BOOTSTRAP" --dry-run --set-secrets 2>&1); then RC=0; else RC=$?; fi
N=$(printf '%s' "$OUT" | grep -c 'gh secret set' || true)
printf '%s\n' "$OUT" >>"$WORK/log.entry"
check "$([ "$RC" -eq 0 ] && echo 0 || echo 1)" "it exits 0"
check "$([ "${N:-0}" -eq 4 ] && echo 0 || echo 1)" "all four values pass the guard and reach the upload step (saw ${N:-0})"

printf '\n=====================================================================\n'
if [ "$FAILED" -eq 0 ]; then
  printf 'RESULT: PASS — every fixture behaved as required (0 failed expectations)\n'
else
  printf 'RESULT: FAIL — %s failed expectation(s)\n' "$FAILED"
fi
rmdir "$WORK" 2>/dev/null || true
exit "$FAILED"
