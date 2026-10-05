/**
 * Gridiron Immortals — the players-board identity key (SERVER ONLY).
 *
 * WHAT IT IS: every device that posts a season sends its own random device
 * token (16-64 characters of [a-z0-9], made by the browser — see
 * `cleanDeviceToken` in src/lib/player-rating.ts). The players board needs to
 * credit a season to the same identity next time, so it needs a stable value to
 * key a row by. It does NOT need the token itself.
 *
 * So the server hashes the token before any store sees it: both stores
 * (src/server/file-board.ts and the `gridiron_players` table) are keyed by
 * `playerKey(token)`, a one-way sha256. Two consequences, both deliberate:
 *
 *  1. NO SERVER-SIDE STORE HOLDS A DEVICE TOKEN. `/privacy` says the device
 *     token is not a secret; hashing keeps that true even for a copy of the
 *     server's file, which matters because the board document is now *shipped
 *     inside the site tree* (see src/server/file-store.ts) and is exported by
 *     GET /api/board-export to be carried forward into the next deploy. A
 *     document full of hashes is safe to move around and safe to read back.
 *  2. THE IDENTITY STILL FOLLOWS THE DEVICE. The same token always hashes to
 *     the same key, and the token never changes on the device, so a rating
 *     survives the hash, a restart, and a redeploy.
 *
 * The hash is a plain sha256 of a domain-separated input. The token is 16+
 * random characters and is deliberately not treated as a secret, so there is
 * nothing here to brute-force, and nothing about the key is stored alongside
 * the value that produced it. This is NOT a password: an attacker who holds a
 * token can still post as that device, which is the account-less scheme's
 * documented weakness and not something a hash can fix.
 *
 * A KEY IS RECOGNISABLE, so callers may pass either form: `playerKeyFor` returns
 * the key for a raw token and passes an already-computed key straight through.
 * Rows written before this scheme (a raw token in the file document, or in
 * `gridiron_players`) are re-keyed on load — see `rekeyPlayerRows`.
 */
import { createHash } from "node:crypto";

/**
 * Domain separation, with a version so a future scheme cannot collide with this
 * one. Changing this string re-keys every identity — treat it as immutable.
 */
const DOMAIN = "gridiron-immortals.players.v1:";

/** sha256 in hex: 64 characters, all of them readable by cleanDeviceToken. */
export const PLAYER_KEY_RE = /^[0-9a-f]{64}$/;

/** The stored key for a device token. Deterministic, one-way, 64 chars. */
export const playerKey = (token: string): string =>
  createHash("sha256")
    .update(`${DOMAIN}${token}`)
    .digest("hex");

/** True for a value this module produced (and for nothing a browser sends). */
export const isPlayerKey = (value: unknown): value is string =>
  typeof value === "string" && PLAYER_KEY_RE.test(value);

/**
 * The key for whatever the caller holds: a raw device token becomes its hash, an
 * already-hashed key is returned unchanged. Used at the two server entry points
 * that receive a token from outside (`submitRun` and POST /api/players), so a
 * double hash can never silently create a second row for one device.
 */
export const playerKeyFor = (value: string): string => (isPlayerKey(value) ? value : playerKey(value));

/** Same, for the nullable token a submission may carry. */
export const playerKeyOrNull = (value: string | null): string | null =>
  value === null ? null : playerKeyFor(value);

/**
 * Re-key rows written before this module existed: a row whose `deviceToken` is
 * not already a key holds a raw token, and its key is derivable from the value
 * itself. In place, and safe to call on every load — a row that is already
 * keyed is untouched. This is what keeps a pre-existing rating with its device
 * across the change instead of orphaning it.
 */
export const rekeyPlayerRows = <T extends { deviceToken: string }>(rows: T[]): T[] => {
  for (const row of rows) {
    if (!isPlayerKey(row.deviceToken)) row.deviceToken = playerKey(row.deviceToken);
  }
  return rows;
};
