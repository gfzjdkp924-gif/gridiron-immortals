#!/usr/bin/env bun
/**
 * THE STORE-BUILD GUARD — the thing that makes "a store build cannot ship with
 * the paywall on" a fact rather than a hope.
 *
 * It reads the FINISHED build in dist/ (not the source) and answers two
 * questions: which of the web game's purchase surfaces are in this bundle, and
 * is it the right EDITION of the app?
 *
 *   bun tools/store-build-check.mjs store   → a store build, i.e. one of the two
 *       app-store editions. Every marker below must be ABSENT. Any one of them
 *       found is a build failure, so a store build that still had a buy link, a
 *       checkout-return route, a price or "first run free" cannot be shipped —
 *       the command that produced it exits non-zero instead of producing a
 *       bundle. The build's own `STORE_PLATFORM` (ios | android) is REQUIRED, and
 *       the bundle must carry that edition's wording and not the other's: the
 *       App Store edition must say it is a paid app, the Play edition must say it
 *       is free, and a build that got the two the wrong way round fails here
 *       rather than in a reviewer's hands (tools/store-edition-rules.mjs holds
 *       the exact phrases).
 *   bun tools/store-build-check.mjs web     → an ordinary web build. Every
 *       marker must be PRESENT. That is the other half of the proof: it shows
 *       the flag really toggles something, rather than the markers having gone
 *       missing everywhere. An edition is neither required nor allowed here —
 *       the web build has no edition (vite.config.ts throws if one is set).
 *
 * The markers are the four surfaces Apple's and Google's rules care about in an
 * app: where the web game sends money, where it sends a payer back to, what it
 * charges, and the free-first-run promise that only makes sense when there is
 * something to buy.
 *
 * WHAT IS SCANNED. Every text file in dist/ — the client chunks, the server
 * bundle, the HTML the server renders, the manifest, the service worker, source
 * maps, CSS and JSON. Images and fonts are skipped: a match inside a PNG would
 * be meaningless, and 0x2f 0x75 0x6e … does not appear in these files anyway.
 * Comments do not reach a build (the bundler strips them), so every hit below is
 * a real string that a player or a reviewer could see.
 *
 * Usage from the site directory (or from anywhere: it finds the repo by the
 * script's own path, so it cannot scan the wrong dist/). The store mode reads
 * STORE_PLATFORM from the environment, which is exactly what the build read.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TEXT_EXTENSIONS,
  checkEditionWording,
  editionFailureExplanation,
  formatEditionReport,
  isEdition,
} from "./store-edition-rules.mjs";

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(SITE_ROOT, "dist");

const MODE = process.argv[2];
if (MODE !== "store" && MODE !== "web") {
  console.error("usage: bun tools/store-build-check.mjs <store|web>");
  process.exit(2);
}

/**
 * WHICH EDITION this build claims to be, from the same environment variable
 * vite.config.ts built with. Required in store mode and forbidden in web mode,
 * because an unlabelled store build would be one that could hand a reviewer the
 * wrong store's sentences — the failure this whole file exists to prevent.
 */
const PLATFORM = process.env.STORE_PLATFORM;
if (MODE === "store" && !isEdition(PLATFORM)) {
  console.error(
    `store-build-check: STORE_PLATFORM must be "ios" (the paid App Store download) or "android" (the free Play download) when checking a store build; got ${JSON.stringify(PLATFORM ?? null)}`,
  );
  console.error(
    "  The build needs it too: STORE_PLATFORM=ios bun run build:store, or STORE_PLATFORM=android bun run build:store.",
  );
  process.exit(2);
}
if (MODE === "web" && PLATFORM !== undefined && PLATFORM !== "") {
  console.error(
    `store-build-check: STORE_PLATFORM=${PLATFORM} is set while checking a WEB build. The web build has no edition — unset it (vite.config.ts refuses to build with one set).`,
  );
  process.exit(2);
}

/** The four surfaces that must not exist in an app-store build. */
const MARKERS = [
  { label: "the Stripe payment link", pattern: /buy\.stripe\.com/g },
  { label: "the /unlock route (or a link to it)", pattern: /\/unlock\b/g },
  { label: '"first run free"', pattern: /first run free/gi },
  { label: "the $4.99 price", pattern: /\$4\.99/g },
];

/**
 * Reported, never fatal: words that are legitimate in an app ("the store you
 * bought it from", the game's own "unlock" verb in unrelated copy) but worth
 * seeing in the report next to the four above.
 */
const ADVISORY = [
  { label: "the word Stripe", pattern: /stripe/gi },
  { label: "the word unlock", pattern: /unlock/gi },
];

const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
};

// The build has to exist first: an empty scan would otherwise "pass" a build
// that was never made, which is the one false green this check must not give.
let files;
try {
  files = walk(DIST);
} catch {
  console.error(`store-build-check: ${relative(SITE_ROOT, DIST)}/ does not exist — build first`);
  process.exit(2);
}
const scanned = files.filter((file) => TEXT_EXTENSIONS.has(extname(file)));
if (scanned.length === 0) {
  console.error(`store-build-check: no build output found in ${relative(SITE_ROOT, DIST)}`);
  process.exit(2);
}

const hits = MARKERS.map((marker) => ({ ...marker, files: [] }));
const advisories = ADVISORY.map((marker) => ({ ...marker, count: 0 }));

for (const file of scanned) {
  const text = readFileSync(file, "utf8");
  const where = relative(SITE_ROOT, file);
  for (const marker of hits) {
    const count = (text.match(marker.pattern) ?? []).length;
    if (count > 0) marker.files.push(`${where} (${count})`);
  }
  for (const marker of advisories) {
    marker.count += (text.match(marker.pattern) ?? []).length;
  }
}

const modeLabel = MODE === "store" ? "STORE build" : "WEB build";
console.log(`store-build-check: ${modeLabel} — scanned ${scanned.length} text files in dist/`);
for (const marker of hits) {
  const state = marker.files.length === 0 ? "absent" : `PRESENT: ${marker.files.join(", ")}`;
  console.log(`  ${MODE === "store" ? "must be absent " : "must be present"} · ${marker.label} → ${state}`);
}
if (MODE === "store") {
  const notes = advisories.filter((marker) => marker.count > 0);
  console.log(
    notes.length === 0
      ? "  advisory · no other purchase-ish wording found"
      : `  advisory (not fatal) · ${notes.map((n) => `${n.label} ×${String(n.count)}`).join(", ")}`,
  );
}

const found = hits.filter((marker) => marker.files.length > 0);
const missing = hits.filter((marker) => marker.files.length === 0);

if (MODE === "store" && found.length > 0) {
  console.error(
    `\nstore-build-check: FAIL — a store build must contain none of these, and ${found.length} survived:`,
  );
  for (const marker of found) console.error(`  - ${marker.label}: ${marker.files.join(", ")}`);
  process.exit(1);
}

if (MODE === "web" && missing.length > 0) {
  console.error(
    `\nstore-build-check: FAIL — a web build must still contain all four, and ${missing.length} are missing:`,
  );
  for (const marker of missing) console.error(`  - ${marker.label}`);
  process.exit(1);
}

// ---- the edition's own wording, against the same finished dist/ --------------
// This is the half of the proof the file swap cannot give: the swap decides what
// the build CAN contain, and this decides what it DOES contain, from the bytes on
// disk. Both directions are fatal in store mode — a missing "This is the paid app"
// in an App Store build means the review-checked copy never shipped, and a present
// "is a paid app" in the Play build is a claim about a price that Google's free→paid
// rule means we could never make true afterwards.
if (MODE === "store") {
  const edition = checkEditionWording(DIST, PLATFORM);
  console.log(formatEditionReport(edition));
  if (!edition.ok) {
    console.error(editionFailureExplanation(edition, "store-build-check"));
    console.error(
      `\n  Note: a bundle can also fail here for the opposite reason — the "${PLATFORM}" build`,
    );
    console.error(
      "  carrying the other store's sentences — which is the failure that matters most.",
    );
    process.exit(1);
  }
  console.log(
    `store-build-check: PASS — no web purchase surface is in this bundle, and its wording is the ${PLATFORM} edition's`,
  );
} else {
  console.log("store-build-check: PASS — the web purchase surfaces are all still here");
}
