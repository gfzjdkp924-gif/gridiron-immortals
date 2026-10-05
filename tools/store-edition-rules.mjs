/**
 * =====================================================================================
 *  THE EDITION RULES — which words a store bundle must, and must not, contain
 * =====================================================================================
 *
 *  There are two app-store editions of this game and they differ on exactly one
 *  fact a store reviewer can see: the App Store download is a PAID app (the store
 *  took one payment before it was installed) and the Google Play download is a
 *  FREE one (no price, no purchase, nothing to unlock). Which one a bundle is, is
 *  the build's own `STORE_PLATFORM` (`ios` / `android`), and the sentences that
 *  say so come from src/lib/store-edition-copy.ts — resolved to that edition's file
 *  by vite.config.ts, so the other edition's copy is not in the bundle at all.
 *
 *  A FILE SWAP ALONE IS NOT A PROOF. This module is the proof half: it names the
 *  sentences that must be present in a finished bundle of each edition and the
 *  sentences that must be absent, so "the Android app cannot tell a reviewer it is
 *  a paid app" is a check that runs against the artifact rather than a claim about
 *  the source. It is shared, deliberately, by every place that needs it:
 *
 *    • tools/store-build-check.mjs   — the finished `dist/` (the whole store build,
 *                                     run by `bun run store:www`, i.e. by BOTH
 *                                     store workflows before anything is packaged)
 *    • tools/store-edition-check.mjs — the same check for any directory, which is
 *                                     what make-store-www.sh points at `www-store/`
 *                                     (the folder Capacitor copies into the app)
 *    • tools/aab-content-guard.sh    — the finished .aab, unzipped, in the Android
 *                                     workflow's own pre-upload check
 *
 *  WHY THE iOS EDITION GETS A "MUST NOT CONTAIN" LIST TOO. The direction that
 *  worries a Play reviewer is the free app claiming a price; the direction that
 *  worries an Apple reviewer is a paid app claiming to be free (a false statement
 *  in a paid download, and Apple's own rule 2.3 is about accurate metadata). Both
 *  are cheap to check, and checking only one would leave the other to be found by
 *  whoever opened the page first.
 *
 *  EVERY MARKER IS A FULL PHRASE, NEVER A BARE WORD: "paid app", not "paid" (the
 *  game says "Every spin paid off"), and the exact sentence openings the copy uses.
 *  The markers are also the strings a human can grep for by hand, which is the
 *  point — a check nobody can re-run is a claim, not a check.
 * =====================================================================================
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

/** The file types that can carry rendered or bundled copy. Images/fonts are skipped. */
export const TEXT_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".html",
  ".css",
  ".map",
  ".txt",
  ".svg",
  ".webmanifest",
  ".xml",
]);

/**
 * True of EVERY edition, checked in every edition's bundle. These come from the
 * part of the store pages that is shared on purpose (StoreLegalPages.tsx: the
 * tail of "the short version"), and they are here so an edition check also proves
 * the shared page actually shipped rather than, say, an empty file.
 */
export const SHARED_WORDING = [
  "There is nothing in the app that measures you, advertises to you, or follows you to another app.",
];

/**
 * The edition-specific wordings. `mustContain` is this edition's own way of
 * naming itself; `mustNotContain` is the other edition's CLAIM — the sentence a
 * player or a store reviewer would read — which may not appear anywhere in this
 * bundle. Each phrase is quoted from src/lib/store-edition-copy.ios.ts /
 * .android.ts.
 *
 * WHY THE FORBIDDEN LIST IS SENTENCES AND NOT THE BARE BIGRAM "paid app"
 * (measured, 2026-10-05). A store bundle keeps its SOURCE COMMENTS: the server
 * chunk (`dist/server/assets/router-*.js`) carries the route modules' and the
 * copy modules' comments inline, and src/lib/build-flags.ts, src/lib/entitlement.ts,
 * src/routes/privacy.tsx and StoreLegalPages.tsx all explain themselves in
 * comments that say things like "the paid app-store build". Those are not visible
 * to anyone — a comment is not rendered, and the pages are checked by
 * `bun run store:www`, which renders them — so the check that matters is whether
 * the bundle contains the CLAIM. A guard that failed on the word in a comment
 * would be a guard somebody would have to switch off to ship.
 */
export const EDITION_RULES = {
  ios: {
    label: "the PAID App Store download",
    mustContain: [
      "This is the paid app", // /support, "What the game is"
      "is a paid app", // /privacy, "The short version"
      "the version you bought", // the home footer (src/lib/paywall.store.ts)
    ],
    mustNotContain: [
      "This is the free app",
      "is a free app",
      "the app you bought",
    ],
  },
  android: {
    label: "the FREE Google Play download",
    mustContain: [
      "This is the free app", // /support, "What the game is"
      "is a free app", // /privacy, "The short version"
      "the app is free", // the home footer / the "no purchase" bullet
    ],
    mustNotContain: [
      "This is the paid app",
      "is a paid app",
      "the version you bought",
      "the app you bought",
    ],
  },
};

/** Is this a platform this file knows the wording of? */
export function isEdition(value) {
  return value === "ios" || value === "android";
}

/** Every text file under `root`, recursively. */
export function walkTextFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (TEXT_EXTENSIONS.has(extname(full))) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** The display path of a file, relative to the directory being scanned. */
function labelFor(root, file) {
  return relative(root, file) || file;
}

/**
 * Check one directory tree against one edition's wording.
 *
 * Returns a report rather than printing, so each caller can decide what its own
 * failure should look like — and so the same answer can be asserted in a proof
 * script. `ok` is false when a required phrase is missing OR a forbidden one is
 * present; both are build failures.
 */
export function checkEditionWording(root, edition) {
  if (!isEdition(edition)) {
    throw new Error(
      `unknown edition "${String(edition)}" — expected "ios" (the paid App Store download) or "android" (the free Play download)`,
    );
  }
  const rules = EDITION_RULES[edition];
  const files = walkTextFiles(root);
  const text = files.map((file) => ({ file: labelFor(root, file), body: readFileSync(file, "utf8") }));

  const present = [];
  const missing = [];
  for (const marker of [...rules.mustContain, ...SHARED_WORDING]) {
    const hits = text.filter((entry) => entry.body.includes(marker)).map((entry) => entry.file);
    if (hits.length > 0) present.push({ marker, hits });
    else missing.push(marker);
  }

  const forbidden = [];
  for (const marker of rules.mustNotContain) {
    const hits = text.filter((entry) => entry.body.includes(marker)).map((entry) => entry.file);
    if (hits.length > 0) forbidden.push({ marker, hits });
  }

  return {
    root,
    edition,
    label: rules.label,
    filesScanned: files.length,
    present,
    missing,
    forbidden,
    ok: missing.length === 0 && forbidden.length === 0,
  };
}

/** The human-readable half of a report, one line per marker. */
export function formatEditionReport(result) {
  const lines = [`  edition · ${result.edition} — ${result.label}`, `  scanned · ${result.filesScanned} text file(s)`];
  for (const hit of result.present) lines.push(`  ok · "${hit.marker}" is present (${hit.hits.length} file(s))`);
  for (const marker of result.missing) lines.push(`  MISSING · "${marker}" must be present and is not`);
  for (const hit of result.forbidden) {
    lines.push(`  FORBIDDEN · "${hit.marker}" must be absent and is in: ${hit.hits.join(", ")}`);
  }
  return lines.join("\n");
}

/** The paragraph that explains a failure, for whichever caller hit it. */
export function editionFailureExplanation(result, where) {
  return [
    "",
    `${where}: FAIL — this bundle does not carry the ${result.edition} edition's wording.`,
    "",
    `  A ${result.edition} build must say what that edition of the app is: ${result.label}.`,
    result.missing.length > 0
      ? `  Missing (the bundle never says it): ${result.missing.map((m) => `"${m}"`).join(", ")}`
      : null,
    result.forbidden.length > 0
      ? `  Wrong edition's words (the bundle says the other store's thing): ${result.forbidden.map((f) => `"${f.marker}"`).join(", ")}`
      : null,
    "",
    "  The usual cause is the build's STORE_PLATFORM: an Android build must be made",
    "  with STORE_PLATFORM=android and an App Store build with STORE_PLATFORM=ios",
    "  (the two workflows set it). Do not fix this by editing the copy: fix the flag,",
    "  and re-run the build so the right edition's file is the one that gets bundled.",
  ]
    .filter((line) => line !== null)
    .join("\n");
}
