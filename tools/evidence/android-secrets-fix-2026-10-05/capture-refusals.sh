#!/usr/bin/env bash
# =====================================================================================
#  capture-refusals.sh — evidence capture for the fixed refusal path.
#
#  tools/proof-android-secret-extraction.sh asserts the banner is printed, but it keeps
#  every raw guard output in a temp directory it deletes on exit (`trap rm -rf`), so the
#  log it leaves behind shows the assertions and not the text they were made on. This
#  script re-runs the same two paths and PRINTS the raw output, so the evidence directory
#  carries the actual `REFUSING TO UPLOAD` line and the `named by the guard:` lines.
#
#    1. the SHIPPED guard block, extracted from tools/github-bootstrap.sh the same way the
#       harness extracts it, sourced with the harness's pass/fail/note/skip stubs and
#       RESULTS_FILE, then verify_signing_material() called directly — the exact path that
#       used to refuse silently
#    2. the real --set-secrets entry point in --dry-run, on the same fixture — to show the
#       banner is printed ONCE, from the guard, and not duplicated by the caller
#
#  NO SECRET IS PRINTED. The fixture README contains deliberately WRONG values (a 40-char
#  store password, an alias that is not the keystore's, a 28-char key password that is not
#  the real one). The real keystore file is used only so the (d) base64 check can pass; the
#  guard prints lengths and an md5, never a value. `gh` is never invoked: --dry-run prints
#  the command it would run.
#
#  USAGE  bash capture-refusals.sh > refusals.txt 2>&1
# =====================================================================================
set -uo pipefail

ROOT=/home/team/shared/site
WORK=$(mktemp -d "${TMPDIR:-/tmp}/gi-refusal-capture.XXXXXX")
trap 'rm -rf -- "$WORK"' EXIT

sed -n '/SIGNING-MATERIAL GUARD — BEGIN/,/SIGNING-MATERIAL GUARD — END/p' \
  "$ROOT/tools/github-bootstrap.sh" >"$WORK/guard.sh"

# The same four stubs and the same RESULTS_FILE contract the harness provides.
RESULTS_FILE="$WORK/results"
: >"$RESULTS_FILE"
record() { printf '%s|%s|%s\n' "$1" "$2" "${3:-}" >>"$RESULTS_FILE"; }
pass()   { record PASS "$1" "${2:-}"; printf '  [PASS] %s\n' "$1"; }
fail()   { record FAIL "$1" "${2:-}"; printf '  [FAIL] %s\n' "$1"; }
note()   { record NOTE "$1" "${2:-}"; printf '  [note] %s\n' "$1"; }
skip()   { record SKIP "$1" "${2:-}"; printf '  [skip] %s\n' "$1"; }

KEYSTORE_FILE=/home/team/shared/secrets/android-upload-key.jks
KEYSTORE_README="$WORK/fake-readme.txt"
cat >"$KEYSTORE_README" <<'EOF'
GRIDIRON IMMORTALS — ANDROID KEY (deliberately wrong fixture: no real values in here)
THE FOUR VALUES (and where each one goes)
  keystore file      android-upload-key.jks      -> ANDROID_KEYSTORE_BASE64 (below)
  store password     pppppppppppppppppppppppppppppppppppppppp
  key alias          not-the-alias      -> ANDROID_KEY_ALIAS
  key password       ZZZZZZZZZZZZZZZZZZZZZZZZZZZZ      -> ANDROID_KEY_PASSWORD   (same value as the store password)
EOF

# shellcheck source=/dev/null
. "$WORK/guard.sh"

printf '### 1. verify_signing_material() called directly — the path the harness exercises,\n'
printf '###    and the one that used to refuse without saying so.\n'
printf '###    guard block: %s lines, sha256 %s\n\n' \
  "$(grep -c . "$WORK/guard.sh")" "$(sha256sum "$WORK/guard.sh" | awk '{print $1}')"
if verify_signing_material; then RC=0; else RC=$?; fi
printf '\nverify_signing_material exit status: %s  (non-zero = the caller must not upload)\n' "$RC"

printf '\n### 2. the real --set-secrets entry point, --dry-run, on the same fixture.\n'
printf '###    Note there is exactly ONE banner: it comes from the guard, and the caller\n'
printf '###    no longer repeats it.\n\n'
if OUT=$(GH_TOKEN=fixture-dry-run-token BOOTSTRAP_KEYSTORE_README="$KEYSTORE_README" \
           bash "$ROOT/tools/github-bootstrap.sh" --dry-run --set-secrets 2>&1); then ENTRY_RC=0; else ENTRY_RC=$?; fi
printf '%s\n' "$OUT" | sed -n '/2. the values/,$p'
printf '\n--set-secrets exit status: %s\n' "$ENTRY_RC"
printf 'banners printed: %s\n' "$(printf '%s' "$OUT" | grep -c 'REFUSING TO UPLOAD')"
printf 'gh secret set lines reached: %s  (must be 0: nothing was uploaded)\n' \
  "$(printf '%s' "$OUT" | grep -c 'gh secret set')"

# ------------------------------------------- 3. the before/after lengths, real README ---
# The four values GitHub was actually given were read out of the real README, so the same
# measurement is repeated here on that file: the OLD extractor (everything after the label,
# annotation included) against the SHIPPED one. LENGTHS ONLY — no value is printed, and the
# old extractor's output is piped straight into `wc -c` and discarded.
printf '\n### 3. the real README (/home/team/shared/secrets/README-keystore.txt), old\n'
printf '###    extractor vs the shipped one. Lengths only; no value is printed.\n\n'
REAL_README=/home/team/shared/secrets/README-keystore.txt
old_len() { printf '%s' "$(printf '%s' "$1" | wc -c)" ; }
OLD_ALIAS=$(sed -n 's/^  key alias *//p' "$REAL_README" | head -1 | wc -c)
OLD_KPW=$(sed -n 's/^  key password *//p' "$REAL_README" | head -1 | sed 's/ *(same value.*$//' | sed 's/ *$//' | wc -c)
OLD_SPW=$(sed -n 's/^  store password *//p' "$REAL_README" | head -1 | wc -c)
NEW_ALIAS=$(sed -n 's/^  key alias *//p' "$REAL_README" | head -1 | awk '{print $1}' | wc -c)
NEW_KPW=$(sed -n 's/^  key password *//p' "$REAL_README" | head -1 | awk '{print $1}' | wc -c)
NEW_SPW=$(sed -n 's/^  store password *//p' "$REAL_README" | head -1 | awk '{print $1}' | wc -c)
printf '  %-22s old %2s chars -> shipped %2s chars\n' "ANDROID_KEY_ALIAS" "$((OLD_ALIAS - 1))" "$((NEW_ALIAS - 1))"
printf '  %-22s old %2s chars -> shipped %2s chars\n' "ANDROID_KEY_PASSWORD" "$((OLD_KPW - 1))" "$((NEW_KPW - 1))"
printf '  %-22s old %2s chars -> shipped %2s chars   (this line has no annotation\n' "ANDROID_KEYSTORE_PASSWORD" "$((OLD_SPW - 1))" "$((NEW_SPW - 1))"
printf '  %s\n' '                                                  column, which is why only two of the four were wrong)'
printf '\n  (wc -c counts the trailing newline, so every number above is printed one lower.)\n'
