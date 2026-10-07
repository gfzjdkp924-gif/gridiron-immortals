#!/usr/bin/env bash
# =====================================================================================
#  github-bootstrap.sh — push this project to GitHub and start the Android CI build.
#
#  Written 2026-10-05 for the Gridiron Immortals team, to be run the moment the owner's
#  fine-grained personal access token (GH_TOKEN) reaches this box. Everything below is
#  idempotent: running it twice is the same as running it once.
#
#  The repository root IS the website project (that is what the CI workflows assert, see
#  .github/workflows/android-play.yml step 1), so this script lives in tools/ and treats
#  its own parent directory as the root. Override with BOOTSTRAP_ROOT to run it against a
#  scratch copy — that is how the dangerous paths are proved without a token.
#
#  WHAT IT WILL NOT DO: print a token, a password or a keystore; commit anything that
#  matches a credential pattern; commit .data/ or the generated android/ project; touch
#  .data/board.json. The scan that enforces that is the same one --check runs.
#
#  ACTIONS (each independently runnable; --check is the default)
#     --check          read-only preflight: root files, ignore rules, secret scan, workflow lint
#     --push           init (if needed), stage, scan, commit, add remote, push
#     --set-secrets    set the four Android repo secrets from the secrets folder via gh
#     --run-android    trigger android-play.yml; --wait polls it and downloads the .aab
#     --dry-run        say exactly what --push / --set-secrets / --run-android would do
#     --wait           (with --run-android) poll to the end and report the conclusion
#
#  ENVIRONMENT OVERRIDES (all optional; --help prints the values in force)
#     BOOTSTRAP_ROOT BOOTSTRAP_REPO BOOTSTRAP_BRANCH BOOTSTRAP_REMOTE
#     BOOTSTRAP_REMOTE_NAME BOOTSTRAP_WORKFLOW BOOTSTRAP_SECRETS_DIR
#     BOOTSTRAP_KEYSTORE_FILE BOOTSTRAP_KEYSTORE_README BOOTSTRAP_ARTIFACT_DIR
#     BOOTSTRAP_WAIT_TIMEOUT BOOTSTRAP_GIT_NAME BOOTSTRAP_GIT_EMAIL
#     BOOTSTRAP_ALLOW_GITIGNORE_EDIT BOOTSTRAP_BOARD_MD5
#     BOOTSTRAP_VERSION_CODE BOOTSTRAP_VERSION_NAME BOOTSTRAP_TARGET_SDK
#
#  REQUIREMENTS: git, gh (only for --set-secrets / --run-android), python3 (PyYAML for
#  the workflow lint), actionlint (fetched to /tmp if missing or skipped with a note),
#  keytool (optional: proves the keystore password before a CI run is spent).
# =====================================================================================
set -euo pipefail

# ------------------------------------------------------------------ configuration -----
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT=${BOOTSTRAP_ROOT:-$(cd -- "$SCRIPT_DIR/.." && pwd)}
REPO_SLUG=${BOOTSTRAP_REPO:-gfzjdkp924-gif/gridiron-immortals}
BRANCH=${BOOTSTRAP_BRANCH:-main}
REMOTE_NAME=${BOOTSTRAP_REMOTE_NAME:-origin}
REMOTE_URL=${BOOTSTRAP_REMOTE:-https://github.com/${REPO_SLUG}.git}
ANDROID_WORKFLOW=${BOOTSTRAP_WORKFLOW:-android-play.yml}
SECRETS_DIR=${BOOTSTRAP_SECRETS_DIR:-/home/team/shared/secrets}
KEYSTORE_FILE=${BOOTSTRAP_KEYSTORE_FILE:-$SECRETS_DIR/android-upload-key.jks}
KEYSTORE_README=${BOOTSTRAP_KEYSTORE_README:-$SECRETS_DIR/README-keystore.txt}
ARTIFACT_DIR=${BOOTSTRAP_ARTIFACT_DIR:-/home/team/shared/android-artifacts}
WAIT_TIMEOUT=${BOOTSTRAP_WAIT_TIMEOUT:-3600}
GIT_NAME=${BOOTSTRAP_GIT_NAME:-Gridiron Immortals}
GIT_EMAIL=${BOOTSTRAP_GIT_EMAIL:-noreply@gridironimmortals.com}
ALLOW_GITIGNORE_EDIT=${BOOTSTRAP_ALLOW_GITIGNORE_EDIT:-1}
BOARD_MD5_EXPECTED=${BOOTSTRAP_BOARD_MD5:-42b9e20395e2dc22d8d6d1dce896f6bc}

# The four Android secrets and where each value comes from. Names are NOT trusted from
# this list: they are read out of the workflow's own `secrets.*` references and every
# referenced name must appear here, or the run stops.
SECRET_NAMES_EXPECTED=(
  ANDROID_KEYSTORE_BASE64
  ANDROID_KEYSTORE_PASSWORD
  ANDROID_KEY_ALIAS
  ANDROID_KEY_PASSWORD
)

# The six files the workflow's first step asserts exist at the repository root. Each name
# is also required to appear in the workflow file itself, so this list cannot silently
# drift away from what CI checks.
ROOT_FILES_EXPECTED=(
  package.json
  capacitor.config.ts
  tools/store-build-check.mjs
  tools/aab-content-guard.sh
  tools/android-icons.py
  wrapper/android/play-icon-512.png
)

DRY=0
WAIT=0
ACTIONS=()
TMP_ROOT=""
RESULTS_FILE=""
IGNORE_CTX=""

# ------------------------------------------------------------------------ plumbing -----
# Everything this script writes goes under one temporary directory, removed on exit. The
# trap body is inline so there is no trap-only function for a linter to puzzle over.
trap 'if [ -n "${TMP_ROOT:-}" ]; then rm -rf -- "$TMP_ROOT"; fi' EXIT

say()  { printf '%s\n' "$*"; }
hr()   { printf '%s\n' "-------------------------------------------------------------------------------"; }
head1(){ hr; printf '== %s\n' "$*"; hr; }

die() { printf '\nFAIL: %s\n' "$*" >&2; exit 1; }

tmpdir() {
  local d
  [ -n "$TMP_ROOT" ] || TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/gi-bootstrap.XXXXXX")
  d=$(mktemp -d "$TMP_ROOT/XXXXXX")
  printf '%s\n' "$d"
}

# Replace anything that looks like the token (or an embedded credential in a URL) with a
# placeholder. The token is read from the environment by the child process, never passed
# as an argument, so it never appears in `ps` or in a command transcript.
redact() {
  python3 -c '
import os, re, sys
t = os.environ.get("GH_TOKEN") or ""
d = sys.stdin.read()
if t:
    d = d.replace(t, "***REDACTED***")
d = re.sub(r"://[^/@\s]*@", "://***REDACTED***@", d)
sys.stdout.write(d)
' 2>/dev/null || cat
}

# run <cmd...> — print the command, then execute it unless --dry-run. Output is redacted.
run() {
  local printable
  printable=$(printf '%s' "$*" | redact)
  if [ "$DRY" -eq 1 ]; then
    printf '   would run: %s\n' "$printable"
    return 0
  fi
  printf '   $ %s\n' "$printable"
  "$@" 2>&1 | redact
}

# capture <cmd...> — run for its output, trimmed of trailing newlines. Read-only helpers
# only (git queries, gh queries); never used for a mutation.
capture() { "$@" 2>/dev/null | tr -d '\r'; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is not installed (needed for ${2:-this action})"
}

record() { printf '%s|%s|%s\n' "$1" "$2" "$3" >>"$RESULTS_FILE"; }
pass()  { record PASS "$1" "${2:-}"; printf '  [PASS] %s\n' "$1"; }
fail()  { record FAIL "$1" "${2:-}"; printf '  [FAIL] %s\n' "$1"; }
note()  { record NOTE "$1" "${2:-}"; printf '  [note] %s\n' "$1"; }
skip()  { record SKIP "$1" "${2:-}"; printf '  [skip] %s\n' "$1"; }

summary() {
  local f n
  head1 "SUMMARY"
  printf '  %-4s %s\n' "PASS" "$(grep -c '^PASS|' "$RESULTS_FILE" 2>/dev/null || true)"
  printf '  %-4s %s\n' "FAIL" "$(grep -c '^FAIL|' "$RESULTS_FILE" 2>/dev/null || true)"
  printf '  %-4s %s\n' "note" "$(grep -c '^NOTE|' "$RESULTS_FILE" 2>/dev/null || true)"
  printf '  %-4s %s\n' "skip" "$(grep -c '^SKIP|' "$RESULTS_FILE" 2>/dev/null || true)"
  while IFS='|' read -r kind name detail; do
    [ "$kind" = FAIL ] || continue
    printf '  FAILED: %s%s\n' "$name" "${detail:+ — $detail}"
    f=1
  done <"$RESULTS_FILE"
  n=$(grep -c '^FAIL|' "$RESULTS_FILE" 2>/dev/null || true)
  if [ "${n:-0}" -gt 0 ]; then
    say ""
    say "RESULT: FAIL ($n problem(s))"
    return 1
  fi
  say ""
  say "RESULT: PASS (nothing above refuses the push)"
  return 0
}

# ------------------------------------------------------------ ignore-rule engine -----
# The tree is not a git repository yet on the first run, and --check must touch nothing, so
# the ignore rules are evaluated either in the real repository (once it exists) or in a
# throwaway repository under $TMPDIR seeded with a copy of every .gitignore the tree
# carries, at the same relative path. `git check-ignore` needs neither the files nor the
# directories to exist; it only applies patterns to paths.
ignore_ctx_init() {
  if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    IGNORE_CTX="$ROOT"
    note "ignore rules evaluated in the real repository at $ROOT"
    return 0
  fi
  local d rel
  d=$(tmpdir)
  git -c core.excludesFile=/dev/null -C "$d" init -q -b main >/dev/null
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    mkdir -p -- "$d/$(dirname -- "$rel")"
    cp -- "$ROOT/$rel" "$d/$rel"
  done < <(cd "$ROOT" && find . -name .gitignore -type f -not -path './node_modules/*' -not -path './.git/*' | sed 's|^\./||')
  IGNORE_CTX="$d"
  note "ignore rules evaluated in a throwaway repository (this tree is not a git repo yet)"
}

# checkignore <path>... — print git's own verdict, with the matching rule and line number.
checkignore() {
  git -c core.excludesFile=/dev/null -C "$IGNORE_CTX" check-ignore --no-index -v -- "$@" || true
}

# candidates — every path that `git add -A` would put into the index: tracked files plus
# untracked files that no ignore rule matches. Written to $1 (one path per line).
candidates() {
  local out=$1 all ign
  all=$(tmpdir)/all.z
  ign=$(tmpdir)/ignored.z
  if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    git -C "$ROOT" ls-files -z --cached --others --exclude-standard >"$all"
  else
    (cd "$ROOT" && find . -path './.git' -prune -o \( -type f -o -type l \) -print0) \
      | sed -z 's|^\./||' >"$all"
  fi
  git -c core.excludesFile=/dev/null -C "$IGNORE_CTX" check-ignore --no-index -z --stdin <"$all" >"$ign" || true
  tr '\0' '\n' <"$all" | LC_ALL=C sort -u >"$out.all"
  tr '\0' '\n' <"$ign" | LC_ALL=C sort -u >"$out.ign"
  LC_ALL=C comm -23 "$out.all" "$out.ign" >"$out"
  rm -f "$out.all" "$out.ign"
}

# --------------------------------------------------------------- secret scanning -----
# High-confidence credential shapes only: a pattern that fires on prose would block a
# legitimate push, and a pattern that is too clever misses the real thing.
SECRET_CONTENT_PATTERNS=(
  '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----'
  'github_pat_[A-Za-z0-9_]{20,}'
  'gh[pousr]_[A-Za-z0-9]{30,}'
  'AKIA[0-9A-Z]{16}'
  'ASIA[0-9A-Z]{16}'
  'sk-(live|test|proj)-[A-Za-z0-9_-]{16,}'
  'sk-ant-[A-Za-z0-9_-]{20,}'
  'AIza[0-9A-Za-z_-]{35}'
  'xox[abprs]-[0-9A-Za-z-]{10,}'
  'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
  '://[^/@[:space:]]+:[^/@[:space:]]+@'
)

SECRET_PATH_PATTERNS=(
  '(^|/)\.env(\..+)?$'
  '\.(jks|keystore|p12|p8|pem|key|pfx|mobileprovision|ppk)$'
  '(^|/)id_(rsa|dsa|ecdsa|ed25519)$'
  '(^|/)keystore(\.|$|/)'
  '(^|/)\.data/'
  '(^|/)secrets?/'
)

# Rules the repository must carry, as `probe path|rule|hard-or-add`. A `hard` rule missing
# from .gitignore is a FAIL; an `add` rule is appended by --push and only noted by --check
# (which touches nothing). The probe is a path the rule must match, so git's own verdict
# decides whether the rule works — this list cannot claim a rule is in force when it is not.
IGNORE_RULES=(
  '.data/board.json|/.data/|hard'
  'upload.jks|*.jks|hard'
  'upload.keystore|*.keystore|hard'
  'upload.p12|*.p12|hard'
  '.env|.env|hard'
  'key.p8|*.p8|add'
  'id_rsa|id_rsa*|add'
  'android/app/build.gradle|/android/|add'
  'www-store/index.html|/www-store/|add'
)

# Appended to .gitignore by --push for any `add` rule that is missing.
GITIGNORE_COMMENT_LINES=(
  '# Generated build output and signing material — none of it is source.'
  '#   android/    created by the CI workflow with npx cap add android, and only used by'
  '#               the workflow when it is ABSENT from the repository, so a committed stale'
  '#               copy would put the runner on the wrong branch with old files.'
  '#   www-store/  created by bun run store:www:ios|android (tools/make-store-www.sh) and'
  '#               rebuilt by the workflow before Capacitor copies it into the app.'
  '#   key.p8      Apple Team API key / private keys. Signing material lives OUTSIDE this'
  '#               repository; these rules are belt-and-braces, not the plan.'
  '#   id_rsa*     SSH private keys.'
)

# scan_paths <listfile> — returns non-zero if any path looks like a credential file, or if
# any listed file's CONTENT matches a credential pattern, or if a file carries JKS
# (fe ed fe ed) magic bytes. Prints only what it found, never the matching text.
scan_paths() {
  local list=$1 rc=0 pf cf hits
  pf=$(tmpdir)/pathpatterns
  cf=$(tmpdir)/contentpatterns
  printf '%s\n' "${SECRET_PATH_PATTERNS[@]}" >"$pf"
  printf '%s\n' "${SECRET_CONTENT_PATTERNS[@]}" >"$cf"
  hits=$(grep -E -f "$pf" "$list" || true)
  if [ -n "$hits" ]; then
    printf '  [FAIL] path looks like a credential file:\n'
    printf '%s\n' "$hits" | sed 's/^/         /'
    rc=1
  fi

  hits=$(python3 - "$list" "$cf" <<'PY' || true
import re, sys
listfile, patfile = sys.argv[1], sys.argv[2]
patterns = [l.rstrip("\n") for l in open(patfile) if l.strip()]
compiled = [(p, re.compile(p)) for p in patterns]
# Documented placeholder forms only. A real `scheme://user:pass@host` is still a hit.
benign = re.compile(r"@127\.0\.0\.1|@localhost[:/]|@0\.0\.0\.0|@\[::1\]|user:password@|USER:PASSWORD@")
found, exempted = [], 0
with open(listfile) as fh:
    for line in fh:
        path = line.rstrip("\n")
        if not path:
            continue
        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                lines = f.readlines()
        except OSError:
            continue
        for n, text in enumerate(lines, 1):
            for pat, rx in compiled:
                if not rx.search(text):
                    continue
                if pat.startswith("://") and benign.search(text):
                    exempted += 1
                    continue
                found.append(f"{path}:{n}  matches {pat}")
                break
print("\n".join(found))
print(f"__EXEMPTED__{exempted}")
PY
)
  local exempted
  exempted=$(printf '%s\n' "$hits" | sed -n 's/^__EXEMPTED__//p' | head -1)
  hits=$(printf '%s\n' "$hits" | grep -v '^__EXEMPTED__' || true)
  if [ -n "$exempted" ] && [ "$exempted" != 0 ]; then
    printf '  [note] %s benign placeholder match(es) exempted (127.0.0.1 / localhost / user:password@)\n' "$exempted"
  fi
  if [ -n "$hits" ]; then
    printf '  [FAIL] file content matches a credential pattern (matching text not shown):\n'
    printf '%s\n' "$hits" | sed 's/^/         /'
    rc=1
  fi

  hits=$(python3 - "$list" <<'PY' || true
import sys
magic = {b"\xfe\xed\xfe\xed": "JKS keystore",
         b"\xce\xce\xce\xce": "JCEKS keystore"}
bad = []
with open(sys.argv[1]) as fh:
    for line in fh:
        p = line.rstrip("\n")
        if not p:
            continue
        try:
            with open(p, "rb") as f:
                head = f.read(4)
        except OSError:
            continue
        for m, label in magic.items():
            if label and head.startswith(m):
                bad.append(f"{p}  ({label})")
print("\n".join(bad))
PY
)
  if [ -n "$hits" ]; then
    printf '  [FAIL] file is a binary keystore:\n'
    printf '%s\n' "$hits" | sed 's/^/         /'
    rc=1
  fi
  return $rc
}

# scan_known_values — does the tree contain a value we are about to upload as a secret? The
# value is written to a 0600 file inside a private temp directory and matched with `grep -f`,
# so it is never on a command line, never in argv and never in a process listing.
scan_known_values() {
  local list=$1 rc=0 d pwf hits
  [ -r "$KEYSTORE_README" ] || { skip "known-value scan" "$KEYSTORE_README not readable"; return 0; }
  d=$(tmpdir)
  pwf="$d/pattern"
  (umask 077; sed -n 's/^  store password *//p' "$KEYSTORE_README" | head -1 >"$pwf")
  [ -s "$pwf" ] || { skip "known-value scan" "no store password found in the README"; return 0; }
  hits=$(xargs -r -a "$list" -d '\n' grep -I -F -l -f "$pwf" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    printf '  [FAIL] a file in the tree contains the keystore store password (value not shown):\n'
    printf '%s\n' "$hits" | sed 's/^/         /'
    rc=1
  fi
  return $rc
}

# ------------------------------------------------------------------- workflow lint ----
find_actionlint() {
  if command -v actionlint >/dev/null 2>&1; then printf '%s\n' "$(command -v actionlint)"; return 0; fi
  if [ -x /tmp/actionlint ]; then printf '%s\n' /tmp/actionlint; return 0; fi
  local d
  d=$(tmpdir)
  if curl -sSL --max-time 30 -o "$d/actionlint.tar.gz" \
      https://github.com/rhysd/actionlint/releases/download/v1.7.7/actionlint_1.7.7_linux_amd64.tar.gz 2>/dev/null; then
    if tar xzf "$d/actionlint.tar.gz" -C "$d" actionlint 2>/dev/null; then
      printf '%s\n' "$d/actionlint"
      return 0
    fi
  fi
  return 1
}

lint_workflows() {
  local wf rc=0 al
  require_cmd python3 "the workflow lint"
  for wf in "$ROOT"/.github/workflows/*.yml; do
    [ -f "$wf" ] || continue
    local base; base=$(basename -- "$wf")
    if python3 -c 'import sys, yaml; yaml.safe_load(open(sys.argv[1]))' "$wf" 2>/dev/null; then
      pass "yaml parse: $base"
    else
      fail "yaml parse: $base" "PyYAML could not load it"
      rc=1
      continue
    fi
    if ! python3 -c 'import yaml' 2>/dev/null; then
      skip "actionlint: $base" "PyYAML missing"
      continue
    fi
    if al=$(find_actionlint); then
      if out=$("$al" "$wf" 2>&1); then
        pass "actionlint: $base"
      else
        fail "actionlint: $base" "actionlint reported problems"
        printf '%s\n' "$out" | sed 's/^/         /'
        rc=1
      fi
    else
      skip "actionlint: $base" "actionlint not available and could not be fetched"
    fi
  done
  return $rc
}

# ----------------------------------------------------------------------- --check ------
cmd_check() {
  head1 "1. repository root"
  local missing=() f
  for f in "${ROOT_FILES_EXPECTED[@]}"; do
    if [ -f "$ROOT/$f" ]; then
      printf '  ok  %s\n' "$f"
    else
      printf '  MISSING  %s\n' "$f"
      missing+=("$f")
    fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    fail "root files" "missing: ${missing[*]}"
  else
    pass "the six files the workflow's first step asserts are present at $ROOT"
  fi

  # The same six names must appear in the workflow that checks them, or this script has
  # drifted from CI (and a green --check would mean nothing).
  local wf="$ROOT/.github/workflows/$ANDROID_WORKFLOW" drift=()
  if [ -f "$wf" ]; then
    for f in "${ROOT_FILES_EXPECTED[@]}"; do
      grep -qF -- "$f" "$wf" || drift+=("$f")
    done
    if [ "${#drift[@]}" -gt 0 ]; then
      fail "root-file list matches $ANDROID_WORKFLOW" "not mentioned in the workflow: ${drift[*]}"
    else
      pass "the six names still come from $ANDROID_WORKFLOW"
    fi
  else
    fail "workflow present" "$wf does not exist"
  fi

  head1 "2. what would be committed"
  ignore_ctx_init
  local cand; cand=$(tmpdir)/candidates
  candidates "$cand"
  local n bytes
  n=$(wc -l <"$cand")
  bytes=$(xargs -r -a "$cand" -d '\n' stat -c %s 2>/dev/null | awk '{s+=$1} END {print s+0}')
  printf '  %s files, %s bytes (%s MiB) would be staged\n' \
    "$n" "$bytes" "$(awk -v b="$bytes" 'BEGIN{printf "%.2f", b/1048576}')"
  if [ "$n" -eq 0 ]; then
    fail "candidate file list" "nothing would be staged — is \$BOOTSTRAP_ROOT right? ($ROOT)"
  else
    pass "candidate file list built from $ROOT ($n files)"
  fi

  head1 "3. git's own verdict on the ignore rules (read-only)"
  local entry probe rest rule kind out missing_hard=0
  local -a missing_add=()
  for entry in "${IGNORE_RULES[@]}"; do
    probe=${entry%%|*}
    rest=${entry#*|}
    rule=${rest%%|*}
    kind=${entry##*|}
    if [ -n "$(checkignore "$probe")" ]; then
      printf '  ignored   %-38s via %s\n' "$probe" "$rule"
    else
      printf '  NOT-IGN   %-38s rule %s missing (%s)\n' "$probe" "$rule" "$kind"
      if [ "$kind" = hard ]; then
        fail "ignore rule $rule" "$probe would be stageable — a credential-shaped path could be committed"
        missing_hard=1
      else
        missing_add+=("$rule")
      fi
    fi
  done
  [ "$missing_hard" -eq 1 ] || pass "every mandatory ignore rule is in force (.data/, *.jks, *.keystore, *.p12, .env)"
  if [ "${#missing_add[@]}" -gt 0 ]; then
    note "ignore rules that only --push adds: ${missing_add[*]} (this check changes nothing)"
  fi
  if [ -z "$(checkignore wrapper/android/play-icon-512.png)" ]; then
    pass "wrapper/android/play-icon-512.png is NOT ignored (the workflow asserts it is in the repo)"
  else
    fail "wrapper/android/play-icon-512.png is ignored" "the workflow asserts this file exists in the repo"
  fi

  head1 "4. secret scan of the candidate tree"
  if scan_paths "$cand"; then
    pass "no credential-shaped path, content match or keystore binary in the candidate tree"
  else
    fail "secret scan" "see the files listed above"
  fi
  if scan_known_values "$cand"; then
    pass "the keystore store password does not appear anywhere in the candidate tree"
  else
    fail "known-value scan" "the keystore password is in the tree — do not push"
  fi

  head1 "5. workflows"
  lint_workflows || true

  head1 "6. the pieces that are not ours to run"
  if [ -n "${GH_TOKEN:-}" ]; then
    pass "GH_TOKEN is present in the environment (--push, --set-secrets and --run-android are usable)"
  else
    note "GH_TOKEN is not set — --push needs it for https://github.com, --set-secrets and --run-android always need it"
  fi
  if [ -f "$KEYSTORE_FILE" ]; then
    printf '  ok  %s (%s bytes) exists — --set-secrets has its value\n' "$KEYSTORE_FILE" "$(stat -c %s "$KEYSTORE_FILE")"
  else
    note "$KEYSTORE_FILE is missing — --set-secrets cannot run"
  fi
  note "iOS: ios-appstore.yml is linted above, nothing more. Bootstrapping it needs the owner's Apple Team API key (not implemented in this script)."

  head1 "7. the board document is untouched"
  board_md5_check

  summary || exit 1
}

board_md5_check() {
  local b="$ROOT/.data/board.json" got
  if [ ! -f "$b" ]; then
    skip "board.json md5" "no .data/board.json"
    return 0
  fi
  got=$(md5sum "$b" | awk '{print $1}')
  if [ "$got" = "$BOARD_MD5_EXPECTED" ]; then
    pass "board.json md5 is still $got"
  else
    fail "board.json md5" "expected $BOARD_MD5_EXPECTED, found $got"
  fi
}

# ------------------------------------------------------------------------ --push ------
repo_is_git() { git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; }

guard_no_parent_repo() {
  if repo_is_git; then return 0; fi
  local top
  top=$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null || true)
  [ -z "$top" ] || die "$ROOT is inside the git repository $top; refusing to stage through it"
}

ensure_repo() {
  guard_no_parent_repo
  if ! repo_is_git; then
    say "   ($ROOT is not a git repository yet — creating one)"
    run git -C "$ROOT" init -q -b "$BRANCH"
  fi
  if [ -z "$(capture git -C "$ROOT" config user.email)" ]; then
    run git -C "$ROOT" config user.email "$GIT_EMAIL"
    run git -C "$ROOT" config user.name "$GIT_NAME"
  fi
  local cur
  cur=$(capture git -C "$ROOT" symbolic-ref --short HEAD || true)
  if [ -z "$cur" ]; then
    run git -C "$ROOT" symbolic-ref HEAD "refs/heads/$BRANCH"
  elif [ "$cur" != "$BRANCH" ]; then
    note "current branch is $cur; the push below targets $BRANCH (branch $BRANCH will be created from it)"
    run git -C "$ROOT" branch -M "$BRANCH"
  fi
}

# Every rule in IGNORE_RULES that is NOT in force, as `rule<TAB>probe<TAB>kind`. git's own
# verdict on the probe decides, so a rule that looks right but does not match is caught.
ignore_rules_missing() {
  local entry probe rest rule kind
  for entry in "${IGNORE_RULES[@]}"; do
    probe=${entry%%|*}
    rest=${entry#*|}
    rule=${rest%%|*}
    kind=${entry##*|}
    if [ -z "$(checkignore "$probe")" ]; then
      printf '%s|%s|%s\n' "$rule" "$probe" "$kind"
    fi
  done
}

# --push appends the missing `add` rules so nothing generated or secret-looking can be
# staged; --check only reports them, because a check that edits files is not a check.
ensure_ignore_rules() {
  local missing; missing=$(ignore_rules_missing | awk -F'|' '$3=="add"')
  if [ -z "$missing" ]; then
    say "   every required ignore rule is already in force"
    return 0
  fi
  say "   rules missing from .gitignore:"
  printf '%s\n' "$missing" | awk -F'|' '{printf "     %-14s so %s is not staged\n", $1, $2}'
  if [ "$DRY" -eq 1 ]; then
    say "   would run: append those rule(s) plus a comment block to $ROOT/.gitignore"
    return 0
  fi
  if [ "$ALLOW_GITIGNORE_EDIT" != 1 ]; then
    die "BOOTSTRAP_ALLOW_GITIGNORE_EDIT=0 and .gitignore is missing rules: $(printf '%s\n' "$missing" | awk -F'|' '{printf "%s ", $1}')"
  fi
  {
    printf '\n'
    printf '%s\n' "${GITIGNORE_COMMENT_LINES[@]}"
    printf '%s\n' "$missing" | awk -F'|' '{print $1}'
  } >>"$ROOT/.gitignore"
  IGNORE_CTX=""
  ignore_ctx_init >/dev/null
  local rule probe kind n=0
  while IFS='|' read -r rule probe kind; do
    [ -n "$rule" ] || continue
    [ -n "$(checkignore "$probe")" ] || die "the rule '$rule' did not take effect for $probe"
    n=$((n + 1))
  done <<<"$missing"
  pass "added $n ignore rule(s) to .gitignore; each one re-verified with git check-ignore"
}

staged_list() { git -C "$ROOT" diff --cached --name-only --diff-filter=ACMR; }

cmd_push() {
  require_cmd git "the push"
  head1 "1. repository, default branch and identity"
  ensure_repo

  head1 "2. ignore rules that keep generated and secret-shaped paths out of the commit"
  ignore_ctx_init >/dev/null
  ensure_ignore_rules

  head1 "3. preflight (the same checks --check runs; this exits if anything fails)"
  cmd_check

  head1 "4. stage"
  if [ "$DRY" -eq 1 ]; then
    local cand; cand=$(tmpdir)/candidates
    candidates "$cand"
    local n bytes
    n=$(wc -l <"$cand")
    bytes=$(xargs -r -a "$cand" -d '\n' stat -c %s 2>/dev/null | awk '{s+=$1} END {print s+0}')
    say "   $n files, $bytes bytes ($(awk -v b="$bytes" 'BEGIN{printf "%.2f", b/1048576}') MiB) would be staged:"
    head -40 "$cand" | sed 's/^/     /'
    [ "$n" -gt 40 ] && say "     … and $((n - 40)) more"
    run git -C "$ROOT" add -A
  else
    git -C "$ROOT" add -A
    local staged; staged=$(staged_list)
    local n bytes
    n=$(printf '%s\n' "$staged" | grep -c . || true)
    bytes=$(printf '%s\n' "$staged" | while IFS= read -r p; do [ -n "$p" ] && stat -c %s "$ROOT/$p" 2>/dev/null; done | awk '{s+=$1} END {print s+0}')
    say "   staged: $n files, $bytes bytes ($(awk -v b="$bytes" 'BEGIN{printf "%.2f", b/1048576}') MiB)"
    printf '%s\n' "$staged" | sed 's/^/     /' | head -60
    [ "$n" -gt 60 ] && say "     … and $((n - 60)) more"
  fi

  head1 "5. scan exactly what is staged (refuses the push on a hit)"
  if [ "$DRY" -eq 1 ]; then
    local cand2; cand2=$(tmpdir)/candidates
    candidates "$cand2"
    scan_paths "$cand2" || true
    scan_known_values "$cand2" || true
  else
    local list; list=$(tmpdir)/staged
    staged_list >"$list"
    if ! scan_paths "$list"; then
      die "the staged tree contains credential material — nothing was committed or pushed"
    fi
    if ! scan_known_values "$list"; then
      die "the staged tree contains the keystore password — nothing was committed or pushed"
    fi
    if grep -q '^android/' "$list"; then
      die "the staged tree contains android/ — refusing; the workflow must generate it"
    fi
    if grep -q '^\.data/' "$list"; then
      die "the staged tree contains .data/ — refusing"
    fi
    pass "staged tree is clean of credential material, android/ and .data/"
  fi

  head1 "6. commit"
  local msg=${BOOTSTRAP_COMMIT_MSG:-"Gridiron Immortals: website, game and store build workflows

Repository root is the website project, which is what the workflows assert
(.github/workflows/android-play.yml step 1). The generated android/ project
is deliberately not committed: the Android workflow creates it on the runner
with 'npx cap add android', which is the branch it is written for."}
  if [ "$DRY" -eq 1 ]; then
    run git -C "$ROOT" commit -m "$msg"
  else
    if git -C "$ROOT" diff --cached --quiet; then
      say "   nothing to commit (working tree already matches the index)"
    else
      git -C "$ROOT" commit -q -m "$msg"
      say "   committed: $(capture git -C "$ROOT" log -1 --pretty='%h %s')"
    fi
  fi

  head1 "7. remote"
  local existing
  existing=$(capture git -C "$ROOT" remote get-url "$REMOTE_NAME" || true)
  if [ -z "$existing" ]; then
    run git -C "$ROOT" remote add "$REMOTE_NAME" "$REMOTE_URL"
  elif [ "$existing" != "$REMOTE_URL" ]; then
    note "remote $REMOTE_NAME was $existing — updating it to $REMOTE_URL"
    run git -C "$ROOT" remote set-url "$REMOTE_NAME" "$REMOTE_URL"
  else
    say "   remote $REMOTE_NAME already points at $REMOTE_URL"
  fi

  head1 "8. push"
  local needs_creds=1
  case "$REMOTE_URL" in
    /*|file://*|.*) needs_creds=0 ;;
  esac
  if [ "$needs_creds" -eq 1 ] && [ -z "${GH_TOKEN:-}" ]; then
    die "GH_TOKEN is not set, so there are no credentials for $REMOTE_URL.
       Save the token on the Secrets page (or export GH_TOKEN=…) and run this again."
  fi
  local -a pargs=(-C "$ROOT")
  if [ "$needs_creds" -eq 1 ]; then
    # The token is handed to git through gh's credential helper, so it never appears in a
    # URL, in argv, or in this transcript.
    pargs+=(-c credential.helper= -c "credential.helper=!$(command -v gh) auth git-credential")
  fi
  pargs+=(push -u "$REMOTE_NAME" "$BRANCH")
  if [ "$DRY" -eq 1 ]; then
    run git "${pargs[@]}"
  else
    GIT_TERMINAL_PROMPT=0 git "${pargs[@]}" 2>&1 | redact
    say "   pushed $BRANCH to $REMOTE_NAME"
  fi

  head1 "9. next"
  say "   repo:   https://github.com/$REPO_SLUG"
  say "   next:   $0 --set-secrets          (four Android secrets, from $SECRETS_DIR)"
  say "           $0 --run-android --wait   (build the .aab on GitHub's runner)"
  if [ "$DRY" -eq 0 ]; then board_md5_check || die "board.json changed during the push — investigate"; fi
}

# ------------------------------------------------------------------ --set-secrets -----
# =====================================================================================
#  SIGNING-MATERIAL GUARD — BEGIN
#  Extracted verbatim from this file by tools/proof-android-secret-extraction.sh (the
#  harness cuts between the two markers), so every assertion below is exercised against
#  synthetic README fixtures without a token and without touching GitHub.
#
#  WHY IT EXISTS. On 2026-10-05 the first CI runs of android-play.yml started with wrong
#  values in the repository. The extractors used to read the README's value column with
#  `sed 's/^  key alias *//p'`, which keeps everything after the label — and
#  /home/team/shared/secrets/README-keystore.txt is a human document with an annotation
#  column. So GitHub received a 41-character alias (`gridiron-upload      ->
#  ANDROID_KEY_ALIAS`) and a 57-character key password, and the runner stopped with
#  `keytool error: java.lang.Exception: Alias <…> does not exist`. The old pre-upload
#  check asked only whether the STORE password opened the keystore, and printed each
#  value's length as a bare number with nothing to compare it to, so "41 chars" looked
#  like a fact rather than the bug.
#
#  WHAT IT GUARANTEES NOW. Before a single `gh secret set` runs, all four of these must
#  hold, and every value's length is printed next to the length it is supposed to have:
#    (a) the extracted store password opens the keystore        (keytool -list)
#    (b) the extracted alias EXISTS in that keystore            (keytool -list -alias)
#    (c) the extracted key password WORKS for that alias        (keytool -certreq, which
#        needs the private key's own password and is the same proof Gradle's signing step
#        needs)
#    (d) the base64 about to be uploaded decodes to the same md5 as the local .jks
#  Any failure refuses the upload, names the secret, and exits non-zero: no CI run is
#  spent on values that are already known to be wrong. When one value fails,
#  verify_signing_material() itself prints the `REFUSING TO UPLOAD` banner and then a
#  `named by the guard:` line per failed secret — from this one place, so the CI log, the
#  --set-secrets entry point and the fixture harness all say the same thing.
# =====================================================================================
# The store password's length. It is a fact about this keystore, measured at creation
# (README-keystore.txt, 2026-10-05), and it is the one expectation keytool cannot tell us:
# an annotated value that survives extraction is caught here. Override only if the
# keystore itself is ever replaced.
EXPECTED_STORE_PASSWORD_LEN=${BOOTSTRAP_STORE_PASSWORD_LEN:-28}
# readme_value <label> — the VALUE of a labelled line in the keystore README.
# The README is written for a human: a label, an optional value column, and then sometimes
# `-> SECRET_NAME` and a trailing parenthetical. The value is the FIRST whitespace-
# delimited token after the label; anything after it is annotation and is dropped. That is
# what makes `  key alias   gridiron-upload   -> ANDROID_KEY_ALIAS` yield the alias and not
# the alias plus its annotation.
readme_value() {
  local label=$1 pat val
  # A label's spaces become "one or more spaces" in BRE syntax (`\+` is a GNU extension;
  # a bare `+` after a bracket expression is a LITERAL plus, which is the bug that made the
  # first version of this function return nothing at all).
  pat=$(printf '%s' "$label" | sed 's/[[:space:]][[:space:]]*/[[:space:]][[:space:]]*/g')
  val=$(sed -n "s/^[[:space:]]*${pat}[[:space:]][[:space:]]*\([^[:space:]][^[:space:]]*\).*/\1/p" "$KEYSTORE_README" | head -1)
  # A line whose value column is empty (only the annotation was written) must read as
  # empty — never as the annotation, which would be uploaded as a value.
  case "$val" in '->'*) val="" ;; esac
  printf '%s' "$val"
}
# Values are read into shell variables and handed to gh on STDIN (gh reads the secret from
# stdin when --body is absent), so no password ever reaches argv.
secret_value_keystore_b64() { base64 -w0 "$KEYSTORE_FILE"; }
secret_value_store_password() { readme_value 'store password'; }
secret_value_key_alias() { readme_value 'key alias'; }
secret_value_key_password() { readme_value 'key password'; }
# keystore_entry_aliases <store password> — the entry alias(es) inside the keystore, one
# per line, read with the password we are about to upload. keytool prints
# `<alias>, <date>, <type>, …`, so everything from the first comma on is dropped. Empty
# output means either the password is wrong or the keystore has no entries.
keystore_entry_aliases() {
  GI_LIST_PW=$1 keytool -list -keystore "$KEYSTORE_FILE" -storepass:env GI_LIST_PW </dev/null 2>/dev/null |
    sed -n '/\(PrivateKeyEntry\|SecretKeyEntry\|trustedCertEntry\)/ s/,.*$//p'
}
# keystore_opens_with <store password> — 0 when keytool opens the keystore with it.
keystore_opens_with() {
  GI_LIST_PW=$1 keytool -list -keystore "$KEYSTORE_FILE" -storepass:env GI_LIST_PW </dev/null >/dev/null 2>&1
}
# keytool_alias_exists <store password> <alias> — 0 when that alias is an entry in it.
# The alias travels on the command line (it is an entry NAME, not a credential — the
# workflow itself passes it this way); the password never does.
keytool_alias_exists() {
  GI_LIST_PW=$1 keytool -list -keystore "$KEYSTORE_FILE" -storepass:env GI_LIST_PW -alias "$2" </dev/null >/dev/null 2>&1
}
# keystore_key_password_works <store password> <alias> <key password> — 0 when keytool can
# read the private key for that alias with that key password. `-certreq` is the cheapest
# operation that actually unwraps the private key, so it fails on a wrong key password and
# succeeds on a right one (proved both ways in the harness).
keystore_key_password_works() {
  local csr rc
  csr=$(mktemp "${TMPDIR:-/tmp}/gi-certreq.XXXXXX")
  GI_KS_PW=$1 GI_KEY_PW=$3 keytool -certreq -alias "$2" -keystore "$KEYSTORE_FILE" \
    -storepass:env GI_KS_PW -keypass:env GI_KEY_PW -file "$csr" </dev/null >/dev/null 2>&1
  rc=$?
  rm -f -- "$csr"
  return "$rc"
}
# keystore_b64_alignment <candidate base64> — decodes it and compares md5s with the local
# .jks. Sets B64_MD5_LOCAL / B64_MD5_DECODED for the caller's message. 0 when identical.
keystore_b64_alignment() {
  local tmp rc
  tmp=$(mktemp "${TMPDIR:-/tmp}/gi-b64check.XXXXXX")
  printf '%s' "$1" | base64 -d >"$tmp" 2>/dev/null
  rc=$?
  B64_MD5_LOCAL=$(md5sum "$KEYSTORE_FILE" 2>/dev/null | awk '{print $1}')
  B64_MD5_DECODED=$(md5sum "$tmp" 2>/dev/null | awk '{print $1}')
  rm -f -- "$tmp"
  [ "$rc" -eq 0 ] && [ -n "$B64_MD5_LOCAL" ] && [ "$B64_MD5_LOCAL" = "$B64_MD5_DECODED" ]
}
# verify_signing_material — the guard. Prints one line per value (length next to expected
# length), records PASS/FAIL through this script's own pass/fail helpers, and returns 0
# only when every check above passed. Callers MUST refuse to upload on non-zero.
verify_signing_material() {
  local alias spw kpw b64 alen splen kplen b64len fsize b64exp entries exp_alias exp_len
  local ok=0
  alias=$(secret_value_key_alias)
  spw=$(secret_value_store_password)
  kpw=$(secret_value_key_password)
  b64=$(secret_value_keystore_b64)
  alen=${#alias}; splen=${#spw}; kplen=${#kpw}; b64len=${#b64}
  fsize=$(stat -c %s "$KEYSTORE_FILE" 2>/dev/null || printf '0')
  b64exp=$(( (fsize + 2) / 3 * 4 ))

  if ! command -v keytool >/dev/null 2>&1; then
    fail "signing material: the three keytool checks" \
         "keytool is not installed, so the store password, the alias and the key password cannot be proved — refusing to upload values that cannot be checked"
    return 1
  fi

  # (a) the store password opens the keystore.
  local entries_ok=0
  if [ "$splen" -ne "$EXPECTED_STORE_PASSWORD_LEN" ]; then
    fail "ANDROID_KEYSTORE_PASSWORD (length)" \
         "extracted $splen chars, expected $EXPECTED_STORE_PASSWORD_LEN — the value is probably carrying annotation from $KEYSTORE_README"
    print_value_len ANDROID_KEYSTORE_PASSWORD "$splen" "$EXPECTED_STORE_PASSWORD_LEN"
  elif keystore_opens_with "$spw"; then
    pass "ANDROID_KEYSTORE_PASSWORD ($splen chars) opens $KEYSTORE_FILE"
    print_value_len ANDROID_KEYSTORE_PASSWORD "$splen" "$EXPECTED_STORE_PASSWORD_LEN"
    entries_ok=1
  else
    fail "ANDROID_KEYSTORE_PASSWORD (keytool)" \
         "$splen chars, expected $EXPECTED_STORE_PASSWORD_LEN (length is right, so this is the wrong value): keytool cannot open $KEYSTORE_FILE with it"
    print_value_len ANDROID_KEYSTORE_PASSWORD "$splen" "$EXPECTED_STORE_PASSWORD_LEN"
  fi

  # (b) the alias exists in the keystore. The expected alias is MEASURED out of the
  # keystore it has to be found in, never assumed.
  if [ "$entries_ok" -eq 1 ]; then
    entries=$(keystore_entry_aliases "$spw")
    if [ -z "$entries" ]; then
      fail "ANDROID_KEY_ALIAS" "the keystore reports no key entry at all, so no alias can be right — investigate it before uploading"
    elif [ "$(printf '%s\n' "$entries" | grep -c .)" != "1" ]; then
      fail "ANDROID_KEY_ALIAS" "the keystore holds $(printf '%s\n' "$entries" | grep -c .) entries; this script assumes exactly one — refusing rather than guessing"
    else
      exp_alias=$(printf '%s' "$entries" | head -1)
      exp_len=${#exp_alias}
      if [ "$alen" -ne "$exp_len" ]; then
        fail "ANDROID_KEY_ALIAS (length)" \
             "extracted $alen chars, expected $exp_len (the keystore's only entry, '$exp_alias') — an over-long alias means extraction kept the README's annotation column"
        print_value_len ANDROID_KEY_ALIAS "$alen" "$exp_len"
      elif keytool_alias_exists "$spw" "$alias"; then
        pass "ANDROID_KEY_ALIAS ($alen chars) is an entry in $KEYSTORE_FILE"
        print_value_len ANDROID_KEY_ALIAS "$alen" "$exp_len"
      else
        fail "ANDROID_KEY_ALIAS (keytool)" \
             "$alen chars, same length as the keystore's entry '$exp_alias' but not equal to it — keytool says alias <$alias> does not exist"
        print_value_len ANDROID_KEY_ALIAS "$alen" "$exp_len"
      fi
    fi
  else
    skip "ANDROID_KEY_ALIAS" "the store password did not open the keystore, so its entries could not be listed"
    print_value_len ANDROID_KEY_ALIAS "$alen" "?"
  fi

  # (c) the key password works for that alias. Length alone cannot decide this: a
  # 28-character wrong password has the right length and still fails, which is why the
  # check is a real keytool operation.
  local kp_len_note
  if [ "$kplen" -eq "$splen" ] && [ "$kpw" = "$spw" ]; then
    kp_len_note="$splen (the same value as the store password, as $KEYSTORE_README records)"
  elif [ "$kplen" -eq "$splen" ]; then
    kp_len_note="$splen (same length as the store password but a different value)"
  else
    kp_len_note="$splen when it is the same value as the store password; this one is a different value"
  fi
  if [ "$alen" -eq 0 ] || [ "$kplen" -eq 0 ]; then
    fail "ANDROID_KEY_PASSWORD" "empty value — check $KEYSTORE_README"
  elif [ "$entries_ok" -eq 1 ] && [ -n "${exp_len:-}" ] && [ "$alen" -eq "$exp_len" ] && keystore_key_password_works "$spw" "$alias" "$kpw"; then
    pass "ANDROID_KEY_PASSWORD ($kplen chars) opens the private key for alias '$alias'"
    print_value_len ANDROID_KEY_PASSWORD "$kplen" "$kp_len_note"
  else
    fail "ANDROID_KEY_PASSWORD (keytool)" \
         "$kplen chars: keytool cannot read the private key for alias '${alias:-<empty>}' with it — this is the check that catches a key password carrying its README annotation"
    print_value_len ANDROID_KEY_PASSWORD "$kplen" "$kp_len_note"
  fi

  # (d) the base64 about to be uploaded is this keystore.
  if keystore_b64_alignment "$b64"; then
    pass "ANDROID_KEYSTORE_BASE64 ($b64len chars) decodes to md5 $B64_MD5_DECODED = the local keystore"
    print_value_len ANDROID_KEYSTORE_BASE64 "$b64len" "$b64exp"
  else
    fail "ANDROID_KEYSTORE_BASE64" \
         "decodes to md5 ${B64_MD5_DECODED:-<nothing>} but $KEYSTORE_FILE is md5 ${B64_MD5_LOCAL:-<unreadable>} — the value being uploaded is not this file"
    print_value_len ANDROID_KEYSTORE_BASE64 "$b64len" "$b64exp"
  fi

  local n
  n=$(grep -c '^FAIL|' "$RESULTS_FILE" 2>/dev/null || true)
  if [ "${n:-0}" -eq 0 ]; then ok=1; fi
  unset alias spw kpw b64
  if [ "${ok:-0}" -eq 1 ]; then return 0; fi
  # THE SINGLE REFUSAL PATH. Every caller gets the same one unmistakable line saying the
  # upload is refused, followed by the name of each secret that failed — and this is where
  # it lives, not in the caller, so a run of this function on its own (exactly what
  # tools/proof-android-secret-extraction.sh does) says it too. The caller sees a non-zero
  # status and must not upload anything. printf only, plus $RESULTS_FILE: the harness that
  # sources this block defines pass/fail/note/skip and RESULTS_FILE, and nothing else.
  printf '\n'
  printf '   REFUSING TO UPLOAD. At least one value above is not the value the keystore\n'
  printf '   accepts, so nothing was set in GitHub and no CI run should be spent on it.\n'
  printf '   An annotation column read as part of a value is the usual cause.\n'
  local bad
  if [ -r "$RESULTS_FILE" ]; then
    while IFS= read -r bad; do
      [ -n "$bad" ] && printf '   named by the guard: %s\n' "$bad"
    done < <(awk -F'|' '/^FAIL[|]/ { sub(/ \(.*$/, "", $2); if ($2 != "") print $2 }' "$RESULTS_FILE" | LC_ALL=C sort -u)
  fi
  return 1
}
# print_value_len <name> <actual> <expected> — one line per value, actual next to expected,
# so a 41-character alias is visible in the log instead of being a bare number.
print_value_len() {
  printf '  len  %-26s %5s chars   expected: %s\n' "$1" "$2" "$3"
}
# =====================================================================================
#  SIGNING-MATERIAL GUARD — END
# =====================================================================================
secret_value_for() {
  case "$1" in
    ANDROID_KEYSTORE_BASE64)   secret_value_keystore_b64 ;;
    ANDROID_KEYSTORE_PASSWORD) secret_value_store_password ;;
    ANDROID_KEY_ALIAS)         secret_value_key_alias ;;
    ANDROID_KEY_PASSWORD)      secret_value_key_password ;;
    *) return 1 ;;
  esac
}

cmd_set_secrets() {
  require_cmd gh "--set-secrets"
  [ -n "${GH_TOKEN:-}" ] || die "GH_TOKEN is not set; --set-secrets needs it (gh reads it from the environment)"
  [ -r "$KEYSTORE_README" ] || die "$KEYSTORE_README is not readable — it holds three of the four values"
  [ -r "$KEYSTORE_FILE" ] || die "$KEYSTORE_FILE is not readable — that is the keystore itself"

  head1 "1. which secret names does the workflow actually use?"
  local wf="$ROOT/.github/workflows/$ANDROID_WORKFLOW"
  [ -f "$wf" ] || die "$wf does not exist"
  local names
  names=$(grep -o 'secrets\.[A-Za-z_][A-Za-z0-9_]*' "$wf" | sed 's/^secrets\.//' | LC_ALL=C sort -u)
  say "$names" | sed 's/^/     /'
  local n ok_name
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    ok_name=0
    for ok in "${SECRET_NAMES_EXPECTED[@]}"; do [ "$n" = "$ok" ] && ok_name=1; done
    [ "$ok_name" -eq 1 ] || die "the workflow references secrets.$n and this script has no value for it"
  done <<<"$names"
  for ok in "${SECRET_NAMES_EXPECTED[@]}"; do
    grep -qx -- "$ok" <<<"$names" || note "this script knows a value for $ok but $ANDROID_WORKFLOW does not reference it"
  done
  pass "the workflow's own secrets.* references are exactly the four the script can fill"

  head1 "2. the values, and the proof they are the ones the keystore actually accepts"
  say "   values are never printed and never passed on a command line: only lengths, and"
  say "   the keystore's md5. The passwords reach keytool through the environment"
  say "   (-storepass:env / -keypass:env) and gh through stdin."
  # The refusal banner and the names of the failed secrets are printed by
  # verify_signing_material itself — the one refusal path — so this log and the fixture
  # harness (tools/proof-android-secret-extraction.sh) read identically. Nothing was
  # written to GitHub: every value is proved before the first `gh secret set` below.
  if ! verify_signing_material; then
    summary || true
    exit 1
  fi
  local name val len
  for name in "${SECRET_NAMES_EXPECTED[@]}"; do
    if ! val=$(secret_value_for "$name"); then continue; fi
    len=${#val}
    if [ "$len" -eq 0 ]; then
      fail "value for $name" "empty — check $KEYSTORE_README"
    else
      printf '  ok  %-26s %s chars, from %s\n' "$name" "$len" \
        "$([ "$name" = ANDROID_KEYSTORE_BASE64 ] && printf '%s' "$KEYSTORE_FILE" || printf '%s' "$KEYSTORE_README")"
    fi
  done

  head1 "3. set them (repo-level secrets $REPO_SLUG)"
  for name in "${SECRET_NAMES_EXPECTED[@]}"; do
    val=$(secret_value_for "$name" || true)
    [ -n "$val" ] || { fail "set $name" "no value"; continue; }
    if [ "$DRY" -eq 1 ]; then
      printf '   would run: gh secret set %s --repo %s   (value piped on stdin, %s chars, not shown)\n' "$name" "$REPO_SLUG" "${#val}"
    else
      printf '   $ gh secret set %s --repo %s   (value on stdin, %s chars, not shown)\n' "$name" "$REPO_SLUG" "${#val}"
      if printf '%s' "$val" | gh secret set "$name" --repo "$REPO_SLUG" >/dev/null 2>&1; then
        pass "set $name"
      else
        fail "set $name" "gh returned an error (is the token allowed to write repository secrets?)"
      fi
    fi
    unset val
  done

  head1 "4. what GitHub now holds (names only)"
  if [ "$DRY" -eq 1 ]; then
    run gh secret list --repo "$REPO_SLUG"
  else
    gh secret list --repo "$REPO_SLUG" 2>&1 | redact | sed 's/^/     /' || \
      fail "gh secret list" "could not list the secrets"
  fi
  note "the job declares environment: google-play. Repo-level secrets are visible to it; if the run stops on the environment, create it under Settings → Environments with no protection rules."
  note "nothing above was written into $ROOT: the values live only in $SECRETS_DIR and in GitHub."
  summary || exit 1
}

# ------------------------------------------------------------------ --run-android -----
cmd_run_android() {
  require_cmd gh "--run-android"
  [ -n "${GH_TOKEN:-}" ] || die "GH_TOKEN is not set; --run-android needs it"
  local wf="$ROOT/.github/workflows/$ANDROID_WORKFLOW"
  [ -f "$wf" ] || die "$wf does not exist"
  grep -q '^  workflow_dispatch:' "$wf" || die "$ANDROID_WORKFLOW has no workflow_dispatch trigger — push-triggered runs would have to be read from the run list instead"

  head1 "1. trigger $ANDROID_WORKFLOW on $REPO_SLUG@$BRANCH"
  local -a args=(workflow run "$ANDROID_WORKFLOW" --repo "$REPO_SLUG" --ref "$BRANCH")
  [ -n "${BOOTSTRAP_VERSION_CODE:-}" ] && args+=(-f "version_code=$BOOTSTRAP_VERSION_CODE")
  [ -n "${BOOTSTRAP_VERSION_NAME:-}" ] && args+=(-f "version_name=$BOOTSTRAP_VERSION_NAME")
  [ -n "${BOOTSTRAP_TARGET_SDK:-}" ]  && args+=(-f "target_sdk=$BOOTSTRAP_TARGET_SDK")
  local before_id
  before_id=$(gh run list --repo "$REPO_SLUG" --workflow "$ANDROID_WORKFLOW" --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)
  say "   latest run before this one: ${before_id:-none}"
  if [ "$DRY" -eq 1 ]; then
    run gh "${args[@]}"
  else
    gh "${args[@]}" 2>&1 | redact | sed 's/^/     /'
  fi

  head1 "2. find the run"
  local id="" tries=0
  if [ "$DRY" -eq 1 ]; then
    say "   would run: gh run list --repo $REPO_SLUG --workflow $ANDROID_WORKFLOW --limit 1 --json databaseId,status"
    say "   (would wait up to 60s for a run newer than ${before_id:-none})"
  else
    while [ "$tries" -lt 20 ]; do
      id=$(gh run list --repo "$REPO_SLUG" --workflow "$ANDROID_WORKFLOW" --limit 1 \
             --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)
      if [ -n "$id" ] && [ "$id" != "${before_id:-}" ]; then break; fi
      id=""
      tries=$((tries + 1))
      sleep 3
    done
    [ -n "$id" ] || die "no new run appeared for $ANDROID_WORKFLOW — check the Actions tab"
    say "   run id: $id — https://github.com/$REPO_SLUG/actions/runs/$id"
  fi

  if [ "$WAIT" -ne 1 ]; then
    say ""
    say "   --wait not given: the run is in flight. To watch it:"
    say "     gh run watch ${id:-<id>} --repo $REPO_SLUG"
    say "   or re-run this script with --run-android --wait"
    return 0
  fi

  head1 "3. wait for it (timeout ${WAIT_TIMEOUT}s)"
  if [ "$DRY" -eq 1 ]; then
    say "   would poll: gh run view <id> --repo $REPO_SLUG --json status,conclusion,number"
    say "   would then download the artifact android-aab-<number> into $ARTIFACT_DIR/run-<number>/"
    return 0
  fi
  local waited=0 status conclusion number
  while [ "$waited" -lt "$WAIT_TIMEOUT" ]; do
    status=$(gh run view "$id" --repo "$REPO_SLUG" --json status --jq '.status' 2>/dev/null || echo unknown)
    if [ "$status" = completed ]; then break; fi
    printf '\r     status: %-12s (%ss)' "$status" "$waited"
    sleep 15
    waited=$((waited + 15))
  done
  printf '\n'
  conclusion=$(gh run view "$id" --repo "$REPO_SLUG" --json conclusion --jq '.conclusion' 2>/dev/null || echo unknown)
  number=$(gh run view "$id" --repo "$REPO_SLUG" --json number --jq '.number' 2>/dev/null || echo "")
  say "   conclusion: $conclusion"

  if [ "$conclusion" != success ]; then
    head1 "4. the failing steps (log excerpt)"
    # shellcheck disable=SC2016  # jq interpolation \(…) inside a single-quoted jq program
    gh run view "$id" --repo "$REPO_SLUG" --json jobs \
      --jq '.jobs[] | .name as $j | .steps[] | select(.conclusion == "failure") | "  FAILED STEP: \($j) -> \(.name)"' 2>/dev/null || true
    say ""
    gh run view "$id" --repo "$REPO_SLUG" --log-failed 2>&1 | redact | tail -80 | sed 's/^/     /' || true
    printf '\nFAIL: the Android workflow finished %s. Full log: https://github.com/%s/actions/runs/%s\n' "$conclusion" "$REPO_SLUG" "$id"
    exit 1
  fi

  head1 "4. download the .aab (outside the repository tree)"
  local dest="$ARTIFACT_DIR/run-${number:-$id}"
  run mkdir -p "$dest"
  if gh run download "$id" --repo "$REPO_SLUG" --name "android-aab-$number" --dir "$dest" 2>&1 | redact | sed 's/^/     /'; then
    local aab
    aab=$(find "$dest" -name '*.aab' -print -quit)
    if [ -n "$aab" ]; then
      say ""
      say "   AAB:    $aab"
      say "   size:   $(stat -c %s "$aab") bytes"
      say "   sha256: $(sha256sum "$aab" | awk '{print $1}')"
      say "   this file is what gets uploaded to Play Console. It is NOT in the repository."
    else
      fail "artifact download" "no .aab in $dest"
    fi
  else
    fail "artifact download" "run succeeded but the artifact could not be downloaded — take it from the run page"
  fi
  board_md5_check || true
  summary || exit 1
}

# -------------------------------------------------------------------------- main ------
usage() {
  sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  cat <<EOF

CURRENT EFFECTIVE SETTINGS (override by exporting the variable)
  BOOTSTRAP_ROOT              $ROOT
  BOOTSTRAP_REPO              $REPO_SLUG
  BOOTSTRAP_BRANCH            $BRANCH
  BOOTSTRAP_REMOTE            $REMOTE_URL
  BOOTSTRAP_REMOTE_NAME       $REMOTE_NAME
  BOOTSTRAP_WORKFLOW          $ANDROID_WORKFLOW
  BOOTSTRAP_SECRETS_DIR       $SECRETS_DIR
  BOOTSTRAP_KEYSTORE_FILE     $KEYSTORE_FILE
  BOOTSTRAP_KEYSTORE_README   $KEYSTORE_README
  BOOTSTRAP_ARTIFACT_DIR      $ARTIFACT_DIR
  BOOTSTRAP_WAIT_TIMEOUT      $WAIT_TIMEOUT
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check)       ACTIONS+=(check) ;;
    --push)        ACTIONS+=(push) ;;
    --set-secrets) ACTIONS+=(set-secrets) ;;
    --run-android) ACTIONS+=(run-android) ;;
    --dry-run)     DRY=1 ;;
    --wait)        WAIT=1 ;;
    -h|--help)     usage; exit 0 ;;
    *)             die "unknown option: $1 (try --help)" ;;
  esac
  shift
done
if [ "${#ACTIONS[@]}" -eq 0 ]; then
  if [ "$DRY" -eq 1 ]; then ACTIONS=(push set-secrets run-android); else ACTIONS=(check); fi
fi
[ "$DRY" -eq 1 ] && say "DRY RUN: nothing below changes the tree, GitHub or the filesystem."

RESULTS_FILE=$(tmpdir)/results
: >"$RESULTS_FILE"

[ -d "$ROOT" ] || die "BOOTSTRAP_ROOT does not exist: $ROOT"
cd -- "$ROOT"

# Each action either finishes cleanly or exits non-zero itself (set -e is in force
# throughout, so an unexpected failure stops the script instead of being swallowed).
for a in "${ACTIONS[@]}"; do
  case "$a" in
    check)       cmd_check ;;
    push)        cmd_push ;;
    set-secrets) cmd_set_secrets ;;
    run-android) cmd_run_android ;;
  esac
done

hr
say "actions run: ${ACTIONS[*]}   root: $ROOT   dry-run: $DRY"
exit 0
