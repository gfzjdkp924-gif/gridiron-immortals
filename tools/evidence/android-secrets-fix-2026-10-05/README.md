# Android signing-secret fix — 2026-10-05

**What was broken.** The first two real runs of `.github/workflows/android-play.yml`
(cancelled `37373960465`, failed `37374141047`) both stopped in the step *"Write the upload
keystore from the repository secrets"* with:

```
keytool error: java.lang.Exception: Alias <***> does not exist
```

The four Android secrets had been read out of
`/home/team/shared/secrets/README-keystore.txt` — a document written for a human, with a
value column **and an annotation column**. The extractors were written as
`sed 's/^  key alias *//p'`, which returns *everything* after the label, so two of the four
values GitHub received carried their annotation:

| secret | GitHub held | the keystore needs |
|---|---|---|
| `ANDROID_KEY_ALIAS` | 41 chars (`gridiron-upload      -> ANDROID_KEY_ALIAS`) | **15** |
| `ANDROID_KEY_PASSWORD` | 57 chars (key password + `-> ANDROID_KEY_PASSWORD   (same value as the store password)`) | **28** |
| `ANDROID_KEYSTORE_PASSWORD` | 28 chars — correct (that line has no annotation column) | 28 |
| `ANDROID_KEYSTORE_BASE64` | correct (it is generated, not read out of the README) | — |

The pre-upload check only asked whether the *store* password opened the keystore — and it
did, so the run was dispatched on values that were already known-wrong. Lengths were printed
as bare numbers with nothing to compare them to, so "41 chars" read like a fact.

**What was fixed** (`tools/github-bootstrap.sh`, the block between the two
`SIGNING-MATERIAL GUARD` markers, so the harness extracts it verbatim):

1. `readme_value()` takes the **first whitespace-delimited token after the label** and drops
   the annotation column. Measured on the real README: alias 41 → **15**, key password
   57 → **28**.
2. The guard now proves all four values before a single `gh secret set` runs — the store
   password opens the keystore (keytool), the alias is an entry **measured out of that
   keystore** and not assumed, the key password really opens the private key, and the base64
   decodes to the md5 of the local `.jks`. Each value's length is printed *next to the length
   it has to have*.
3. **The gap closed in this session:** the `REFUSING TO UPLOAD` banner used to be printed by
   the *caller* (`cmd_set_secrets`), so a refusal raised by `verify_signing_material()`
   itself — which is exactly how `tools/proof-android-secret-extraction.sh` must test it —
   refused silently. The banner and the per-secret `named by the guard:` lines now come from
   the single shared refusal path inside `verify_signing_material()`, printed with `printf`
   only (the harness defines `pass/fail/note/skip` and `RESULTS_FILE`, nothing else), and the
   caller no longer repeats them. Every refusal — CI log, `--set-secrets` entry point, fixture
   harness — now reads identically, and the banner appears exactly once.

**What the log proves.**

* `harness.log` — `bash tools/proof-android-secret-extraction.sh`, the shipped harness, run
  against the current `tools/github-bootstrap.sh`. **48 `[ok]`, 0 `[NO]`,
  `RESULT: PASS — every fixture behaved as required (0 failed expectations)`.** That covers:
  the guard block is cut out verbatim and defines its functions; the real README extracts to
  28 / 15 / 28 chars; the old extractor on the same annotated line yields the 41-char alias
  GitHub actually received (and 57 for the key password) while the new one yields 15 and 28;
  three good fixtures (annotated, bare, irregularly padded) pass; **four bad fixtures exit 1,
  name the right secret, and print the refusal banner**; the base64 alignment check refuses a
  tampered keystore and still passes the real one; and the real `--set-secrets --dry-run`
  entry point reaches four `gh secret set` lines on the good fixtures and **zero** on the bad
  ones.
* `refusals.txt` — the raw text those assertions were made on. The harness keeps its raw
  guard output in a temp directory it deletes on exit, so `capture-refusals.sh` re-runs the
  two refusal paths and prints them:
  * §1 the shipped guard block, sourced with the harness's stubs and called directly — shows
    `REFUSING TO UPLOAD …` followed by `named by the guard: ANDROID_KEYSTORE_PASSWORD` and
    `named by the guard: ANDROID_KEY_PASSWORD`, exit status 1. **This is the path that was
    silent before this session's change.**
  * §2 the real `--set-secrets --dry-run` on the same deliberately-wrong fixture — one banner
    (`banners printed: 1`, not two), `gh secret set lines reached: 0`.
  * §3 the before/after lengths measured on the real README: alias **41 → 15**, key password
    **57 → 28**, store password 28 → 28 (its line has no annotation column).
  Nothing in either file contains a secret value: the fixture holds deliberately wrong values
  and every other number is a length or an md5.
* `faillog-37374141047.txt` / `report-37374141047.md` — the "before" CI evidence, copied from
  the artifacts directory: the failing step verbatim, ending in
  `keytool error: java.lang.Exception: Alias <***> does not exist`.

**Safety.** No secret value appears in this directory, in either tool, or in the commit. The
harness needs no token; `gh` is never invoked (the real entry point runs in `--dry-run`, which
prints the command it *would* run, and passwords only ever reach `keytool` through the
environment and `gh` through stdin).

**Pinned to the exact code it proves.** `tools/github-bootstrap.sh` sha256
`6e82ffccf11c15dc2a516b8218bd31669c82d11103054db208dd9aa37e54cb65`;
`tools/proof-android-secret-extraction.sh` sha256
`b1a563fc70a16d4e2592934153cbb1e244cdf1fff1b6d20d9b8aed4a49bb41df`. Both `harness.log` and
`refusals.txt` print the sha256 of the guard block they ran
(`abc06251042ee2405d7bab11915d7bbcd277d516cdb9992469870f7e52cc406e`, 223 lines), which is what
a fresh extraction of the guard markers from that file produces — so the logs cannot have been
taken from a different revision. The only secret-derived string in these files is the key
**alias** (`gridiron-upload`), quoted in the tool's own header and above because it is how the
41-character bug is described; neither password appears anywhere. The alias is not usable
without the keystore, which is never in the repository (`*.jks` is ignored and the file lives
in `/home/team/shared/secrets/`).
