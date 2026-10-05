#!/usr/bin/env bun
/**
 * =====================================================================================
 *  THE EDITION CHECK, AS A COMMAND — `bun tools/store-edition-check.mjs <dir> <edition>`
 * =====================================================================================
 *
 *  Answers one question about a directory of built files: does it carry THIS store
 *  edition's own wording, and none of the other edition's? The rules live in
 *  tools/store-edition-rules.mjs, shared with the store-build guard
 *  (tools/store-build-check.mjs, which checks the finished `dist/`) and with the
 *  Android bundle guard (tools/aab-content-guard.sh, which checks the finished
 *  .aab after unzipping it).
 *
 *  WHY IT IS A SEPARATE COMMAND AS WELL AS AN IMPORT. Some artifacts are not in a
 *  repo layout: an unzipped .aab, and `www-store/` (the folder Capacitor copies
 *  into the app, which is what actually becomes the installed app's pages). Both
 *  are just directories of files, so both can be checked by this one command:
 *
 *     bun tools/store-edition-check.mjs dist ios
 *     bun tools/store-edition-check.mjs www-store android
 *     bun tools/store-edition-check.mjs /tmp/aaab-extract android
 *
 *  Exit: 0 = the wording is this edition's; 1 = it is not (and the log says which
 *  phrase is missing and which wrong-edition phrase is present); 2 = misuse (no
 *  such directory, or an edition this project does not have).
 * =====================================================================================
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import {
  checkEditionWording,
  editionFailureExplanation,
  formatEditionReport,
  isEdition,
} from "./store-edition-rules.mjs";

const dir = process.argv[2];
const edition = process.argv[3];

if (!dir || !edition) {
  console.error("usage: bun tools/store-edition-check.mjs <directory> <ios|android>");
  process.exit(2);
}
if (!isEdition(edition)) {
  console.error(
    `store-edition-check: "${edition}" is not an edition of this app — expected "ios" (the paid App Store download) or "android" (the free Play download)`,
  );
  process.exit(2);
}

const root = resolve(dir);
if (!existsSync(root) || !statSync(root).isDirectory()) {
  console.error(`store-edition-check: ${root} is not a directory — build it first, then check it`);
  process.exit(2);
}

console.log(`store-edition-check: ${root}`);
const result = checkEditionWording(root, edition);
console.log(formatEditionReport(result));

if (!result.ok) {
  console.error(editionFailureExplanation(result, "store-edition-check"));
  process.exit(1);
}

console.log(
  `store-edition-check: PASS — this is the ${edition} edition's wording, and the other store's wording is not in it`,
);
