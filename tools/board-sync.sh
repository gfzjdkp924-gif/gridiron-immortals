#!/usr/bin/env bash
#
# board-sync.sh — CARRY THE LIVE BOARD FORWARD INTO THE NEXT PUBLISH.
#
# WHY THIS EXISTS. The boards (runs + players ratings) are kept in a file inside
# the deployed site tree: `<deploy root>/.data/board.json`. A publish replaces the
# whole tree with this workspace, so the file that ships is the board's base
# state on the next deploy. That is what makes a posted season outlive an update
# — and it only works if THIS step runs first: the running game's copy of the
# board has to be read back out and written into the workspace file, or the
# publish replaces the newest board with an older one.
#
#   SEQUENCE, every time:
#     bash tools/board-sync.sh          # pulls the LIVE board into .data/board.json
#     <publish the site>                # ships that file
#
# WHAT IT READS. `GET <live>/api/board-export`, which returns the board's own
# document (runs, players and the anonymous finished-season counters) from
# whichever store is answering. If that endpoint is not on the live site yet (it
# ships with this change), it falls back to the public `GET /api/leaderboard` and
# carries the RUNS forward, keeping the players rows already in the local file —
# it says so loudly when it does.
#
# THE COUNTERS ARE MERGED, NEVER REPLACED. `stats` (src/lib/run-stats.ts:
# runsFinished, firstRuns, byDay, firstByDay, updatedAt) lives in this same
# document, so the same carry-forward step is what keeps it alive across a
# publish — and the same failure mode has to be closed: a degraded, empty or
# unreadable live read must never be able to ZERO the counters. Counters only
# ever grow, so the rule is the maximum of the two readings, field by field and
# day by day (merge_stats below mirrors mergeRunStats in src/lib/run-stats.ts).
# The store does the same thing inside a running process, so all three layers
# agree.
#
# WHAT IT REFUSES TO DO, on purpose:
#   - an unreachable site, an error, or a read that means nothing -> the baked
#     file is left exactly as it is (exit 3);
#   - a live board with no runs and no ratings -> not written over a populated
#     file (exit 3) unless --allow-empty is passed; a document that holds only
#     counters is treated as empty here too, because counters alone must not be a
#     reason to write a board whose runs came back blank;
#   - a document that is not a board -> never written (exit 3).
# It replaces the runs and the ratings WHOLESALE rather than merging: the live
# board is the truth, so rows created on someone's dev copy (including this
# machine's) never ship to the live board. The counters are the one exception to
# the wholesale rule, and only because they are monotonic — see above.
#
# USAGE
#   bash tools/board-sync.sh [--url=URL] [--file=PATH] [--allow-empty] [--dry-run]
#     --url=URL       the live site (default https://www.gridironimmortals.com,
#                     or $GRIDIRON_LIVE_URL)
#     --file=PATH     the board document to write (default <site>/.data/board.json)
#     --allow-empty   write even when the live board holds nothing (used to bake
#                     in a deliberately empty base state; not for routine runs)
#     --dry-run       read and report, write nothing
#
# EXIT CODES  0 = the file is current (written, or already identical)
#             3 = nothing was changed (unreachable / empty / not a board)
#             1 = a real error (bad arguments, unwritable file)
#
set -euo pipefail

SITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIVE="${GRIDIRON_LIVE_URL:-https://www.gridironimmortals.com}"
TARGET="${GRIDIRON_BOARD_FILE:-$SITE_DIR/.data/board.json}"
ALLOW_EMPTY=0
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --url=*) LIVE="${arg#--url=}" ;;
    --file=*) TARGET="${arg#--file=}" ;;
    --allow-empty) ALLOW_EMPTY=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h | --help)
      sed -n '2,50p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "board-sync: unknown argument '$arg' (try --help)" >&2
      exit 1
      ;;
  esac
done
LIVE="${LIVE%/}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "board-sync: live board  $LIVE"
echo "board-sync: baked file  $TARGET"

# --- read the live board -----------------------------------------------------
# The export endpoint first. `-o body -w code` keeps the two apart whatever curl
# exits with, so a network failure is data here, not a crash.
CODE="$(curl -sS --max-time 25 -o "$WORK/export.json" -w '%{http_code}' "$LIVE/api/board-export" 2>"$WORK/curl.err" || true)"
if [ -z "$CODE" ]; then CODE="000"; fi
MODE=""
case "$CODE" in
  200) MODE="export" ;;
  404 | 405 | 410 | 501) MODE="legacy" ;;
  *) MODE="unreachable" ;;
esac

if [ "$MODE" = "unreachable" ]; then
  echo "board-sync: could not read $LIVE/api/board-export (HTTP $CODE)${CODE:+, $(head -c 200 "$WORK/curl.err" | tr '\n' ' ')}"
fi

if [ "$MODE" = "legacy" ]; then
  echo "board-sync: /api/board-export is not on the live site yet (HTTP $CODE) — falling back to the public board (runs only, players kept from the baked file)"
  CODE="$(curl -sS --max-time 25 -o "$WORK/board.json" -w '%{http_code}' "$LIVE/api/leaderboard" 2>"$WORK/curl.err" || true)"
  if [ -z "$CODE" ]; then CODE="000"; fi
fi

# --- decide, then write (all of it in python: parsing, guarding, atomic write) -
MODE="$MODE" ALLOW_EMPTY="$ALLOW_EMPTY" DRY_RUN="$DRY_RUN" TARGET="$TARGET" \
  CODE="$CODE" WORK="$WORK" python3 - <<'PY'
import json, os, pathlib, re, shutil, sys, time
from datetime import datetime

work = pathlib.Path(os.environ["WORK"])
target = pathlib.Path(os.environ["TARGET"])
mode = os.environ["MODE"]
code = os.environ["CODE"]
allow_empty = os.environ["ALLOW_EMPTY"] == "1"
dry_run = os.environ["DRY_RUN"] == "1"


def fail(msg, exit_code=3):
    print(f"board-sync: {msg}")
    sys.exit(exit_code)


def load(path):
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def board_shape(doc):
    return (
        isinstance(doc, dict)
        and isinstance(doc.get("runs"), list)
        and isinstance(doc.get("players"), list)
    )


def counts(doc):
    if not board_shape(doc):
        return (0, 0)
    return (len(doc["runs"]), len(doc["players"]))


# --- the finished-season counters -------------------------------------------
# A MIRROR of src/lib/run-stats.ts (sanitizeRunStats / mergeRunStats /
# addFinishedRun's day keys). Same field names, same 30-day window, same rule:
# counters only ever grow, so the larger of two readings wins and a degraded read
# can never zero them. Change one, change the other.
KEEP_DAYS = 30
MAX_COUNTER = 100_000_000
DAY_KEY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def counter(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        try:
            value = float(value)
        except (TypeError, ValueError):
            return 0
    if value != value or value < 0:  # NaN or negative
        return 0
    return min(MAX_COUNTER, int(value))


def day_map(value):
    out = {}
    if not isinstance(value, dict):
        return out
    for key, raw in value.items():
        if not isinstance(key, str) or not DAY_KEY.match(key):
            continue
        n = counter(raw)
        if n > 0:
            out[key] = n
    return out


def sum_days(days):
    return sum(int(n) for n in days.values())


def prune_days(days):
    if len(days) <= KEEP_DAYS:
        return days
    return {key: days[key] for key in sorted(days)[-KEEP_DAYS:]}


def iso_stamp(value):
    """A real timestamp or None. Kept as it stands (the store normalises its own
    writes; this only has to refuse a hand-edited non-date)."""
    if not isinstance(value, str) or not value:
        return None
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return value


def sanitize_stats(value):
    if not isinstance(value, dict):
        value = {}
    by_day = prune_days(day_map(value.get("byDay")))
    first_by_day = prune_days(day_map(value.get("firstByDay")))
    # A total is never reported below what its days add up to.
    return {
        "runsFinished": max(counter(value.get("runsFinished")), sum_days(by_day)),
        "firstRuns": max(counter(value.get("firstRuns")), sum_days(first_by_day)),
        "byDay": by_day,
        "firstByDay": first_by_day,
        "updatedAt": iso_stamp(value.get("updatedAt")),
    }


def merge_stats(a, b):
    left, right = sanitize_stats(a), sanitize_stats(b)
    by_day = dict(left["byDay"])
    for key, n in right["byDay"].items():
        by_day[key] = max(by_day.get(key, 0), n)
    first_by_day = dict(left["firstByDay"])
    for key, n in right["firstByDay"].items():
        first_by_day[key] = max(first_by_day.get(key, 0), n)
    by_day, first_by_day = prune_days(by_day), prune_days(first_by_day)
    stamps = [s for s in (left["updatedAt"], right["updatedAt"]) if s]
    return {
        "runsFinished": max(left["runsFinished"], right["runsFinished"], sum_days(by_day)),
        "firstRuns": max(left["firstRuns"], right["firstRuns"], sum_days(first_by_day)),
        "byDay": by_day,
        "firstByDay": first_by_day,
        "updatedAt": max(stamps) if stamps else None,
    }


def stats_line(doc):
    stats = sanitize_stats(doc.get("stats") if isinstance(doc, dict) else None)
    return (
        f"{stats['runsFinished']} finished season{'s' if stats['runsFinished'] != 1 else ''} counted"
        f" ({stats['firstRuns']} first)"
    )


def describe(label, doc):
    runs, players = counts(doc)
    print(
        f"board-sync: {label}: {runs} season{'s' if runs != 1 else ''}, "
        f"{players} rating row{'s' if players != 1 else ''}, {stats_line(doc)}"
    )


current = load(target) if target.exists() else None
if current is not None and not board_shape(current):
    print("board-sync: the baked file is not a board document — it will be replaced only by a good read")
    current = None
describe("baked file", current)
baked_stats = sanitize_stats(current.get("stats")) if current is not None else sanitize_stats(None)

if mode == "unreachable":
    fail(
        f"LIVE BOARD NOT READ (HTTP {code}) — the baked file is unchanged. Publishing now ships the previous board; run this again once the site answers.",
    )

body = load(work / ("export.json" if mode == "export" else "board.json"))
if body is None:
    fail(f"the live site answered HTTP {code} with something that is not JSON — the baked file is unchanged")

next_doc = None
if mode == "export":
    if body.get("ok") is not True:
        fail(
            f"the live board refused the read ({body.get('reason') or body.get('source') or 'unknown'}) — the baked file is unchanged",
        )
    if body.get("source") == "postgres":
        print("board-sync: the live boards are answering from the database, so the file document is not the live board")
        print("board-sync: NOTHING TO CARRY FORWARD — the baked file is unchanged (nothing depends on it while the database answers)")
        sys.exit(0)
    doc = body.get("document")
    if not board_shape(doc):
        fail("the export carried no board document — the baked file is unchanged")
    # Copied, not handed on: only the counters are merged below; the runs and the
    # ratings are still written exactly as the live board holds them.
    next_doc = dict(doc)
    source = "the live board (runs + ratings + counters)"
else:
    entries = body.get("entries")
    if not isinstance(entries, list):
        fail("the public board returned no entry list — the baked file is unchanged")
    runs = [
        {
            "id": int(e.get("id") or 0),
            "name": str(e.get("name") or "—"),
            "wins": int(e.get("wins") or 0),
            "losses": int(e.get("losses") or 0),
            "undefeated": bool(e.get("undefeated")),
            "overall": float(e.get("overall") or 0),
            "lineup": e.get("lineup") if isinstance(e.get("lineup"), list) else [],
            "createdAt": str(e.get("createdAt") or ""),
        }
        for e in entries
        if isinstance(e, dict) and int(e.get("id") or 0) > 0
    ]
    kept_players = current["players"] if current is not None and board_shape(current) else []
    # DEGRADED MODE GUARD. This path reads runs only, so a read that comes back
    # with no runs at all must never be written: it would wipe the runs in the
    # baked file while the rating rows survived, which is exactly the failure this
    # script exists to prevent. It must also never SHRINK the run list: the public
    # board is the only source here, and a shorter list means a partial read or a
    # live board that legitimately has fewer seasons — neither is a reason to
    # throw away what we already carry. Re-run once the export endpoint is live.
    local_runs = len(current["runs"]) if current is not None and board_shape(current) else 0
    if len(runs) == 0:
        fail(
            "the public board returned no seasons — the baked file is unchanged (writing this would wipe the runs it carries). The export endpoint on the live site is what makes this path unnecessary; re-run once it is deployed.",
        )
    if len(runs) < local_runs:
        fail(
            f"the public board lists {len(runs)} seasons but the baked file already carries {local_runs} — refusing to shrink the board in this degraded (runs-only) path. The baked file is unchanged.",
        )
    highest = max([r["id"] for r in runs] + [0])
    next_doc = {
        "version": 1,
        # The public board carries no counters, so this is the baked file's own
        # reading; the merge below keeps it (it can never be zeroed here).
        "stats": body.get("stats"),
        "nextId": max(highest + 1, int((current or {}).get("nextId") or 1), 1),
        "runs": runs,
        "players": kept_players,
    }
    source = f"the public board (runs only; {len(kept_players)} rating rows kept from the baked file)"

runs, players = counts(next_doc)
describe("live board", next_doc)
print(f"board-sync: read from {source}")
local_runs_now = len(current["runs"]) if current is not None and board_shape(current) else 0
if runs < local_runs_now:
    print(
        f"board-sync: WARNING — the live board holds fewer seasons ({runs}) than the baked file ({local_runs_now}); writing the live state, which is the truth of the board right now",
    )

if runs == 0 and players == 0 and not allow_empty:
    fail(
        "THE LIVE BOARD IS EMPTY — the baked file is left alone, so an empty or half-read board can never wipe a good one. (Counters alone are not a board either: a document holding only counters is treated as empty, so a degraded read that kept them cannot blank out the runs.) Use --allow-empty only to bake in a deliberately empty base state.",
    )
if runs == 0 and players == 0 and allow_empty:
    print("board-sync: --allow-empty: writing the empty state on purpose")

# THE COUNTERS ARE MERGED, NEVER REPLACED (see the header). This runs on every
# write path, whatever the run/rating guard above just decided, so the number the
# owner watches cannot be zeroed by a degraded read, by an older build of the
# game answering, or by a publish landing mid-session. The single exception is
# --allow-empty with an empty read: that is a deliberate reset of the base state
# and takes the (empty) reading as it stands.
if runs == 0 and players == 0 and allow_empty:
    next_doc["stats"] = sanitize_stats(next_doc.get("stats"))
else:
    live_stats = sanitize_stats(next_doc.get("stats"))
    merged = merge_stats(live_stats, baked_stats)
    if merged != live_stats:
        print(
            "board-sync: counters: the live read has "
            f"{live_stats['runsFinished']} finished / {live_stats['firstRuns']} first; keeping "
            f"{merged['runsFinished']} / {merged['firstRuns']} — counters only ever grow, so the larger reading wins",
        )
    next_doc["stats"] = merged

if current is not None and next_doc == current:
    print("board-sync: the baked file already matches the live board — nothing to write")
    sys.exit(0)

if current is not None and dry_run:
    describe("would write", next_doc)

if dry_run:
    print("board-sync: --dry-run: nothing written")
    sys.exit(0)

if current is not None:
    # Outside the site tree, so a backup can never become part of a publish.
    backup = pathlib.Path("/tmp") / f"gridiron-board-{time.strftime('%Y%m%d-%H%M%S')}.json"
    try:
        shutil.copyfile(target, backup)
        print(f"board-sync: previous file copied to {backup}")
    except OSError as error:
        print(f"board-sync: could not copy a backup ({error}) — continuing")

target.parent.mkdir(parents=True, exist_ok=True)
temp = target.parent / f".board-sync-{os.getpid()}.tmp"
try:
    temp.write_text(json.dumps(next_doc, separators=(",", ":")) + "\n")
    os.replace(temp, target)  # atomic: a reader sees the old file or the new one
except OSError as error:
    temp.unlink(missing_ok=True)
    fail(f"could not write {target}: {error}", exit_code=1)

written = load(target)
describe("baked file now", written)
print("board-sync: DONE — publish the site now and this board goes with it")
PY
