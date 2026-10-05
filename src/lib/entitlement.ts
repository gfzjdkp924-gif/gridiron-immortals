/**
 * Gridiron Immortals — the device's entitlement: the one free run and the
 * $4.99 unlock.
 *
 * THE STORE BUILD HAS NO ENTITLEMENT. In the paid app-store download the store
 * collected the money before the app was installed, so there is nothing to gate
 * and nothing to unlock: `isUnlocked()` answers true and `hasFinishedARun()`
 * answers false for every device, for as long as the app is installed, with no
 * storage involved. That is what makes a fresh device able to start a run
 * immediately and repeat runs forever — see the two functions below, which are
 * the ONLY place the game asks whether a device may play. Everything that reads
 * them — the gate in `startRun` (src/components/Game.tsx), the posting panel,
 * the boards' lock notes, `isFirstFinishedRun` (src/lib/run-count.ts) — follows
 * from here without knowing which build it is in.
 *
 * Two localStorage keys, deliberately separate from each other and from the
 * saved-runs key:
 *
 *   gridiron-immortals.unlock.v1   the paid unlock (per device, forever)
 *   gridiron-immortals.freeRun.v1  "this device has finished its free run"
 *
 * Never the runs key (`gridiron-immortals.runs.v1`): clearing saved runs is a
 * housekeeping button and must not hand out a fresh free run, and a corrupt
 * runs list must never be able to mint an unlock.
 *
 * Honest limits, stated once here rather than repeated per screen:
 *  - The free run is device-lifetime, not daily. A daily reset would be a
 *    subscription in all but name.
 *  - The unlock is written by `/unlock` from the query string Stripe redirects
 *    with. There is no server and no Stripe secret on this account, so the page
 *    can shape-check the reference but it CANNOT verify the payment. Everything
 *    stored is therefore `verified: false`, and no copy anywhere may call it a
 *    verified purchase.
 *  - Because it is browser-local, a payer can pass the unlock on. That is the
 *    documented cost of having no accounts, not a bug to paper over.
 */
import { useEffect, useState } from "react";

import { STORE_BUILD } from "~/lib/build-flags";

export const UNLOCK_KEY = "gridiron-immortals.unlock.v1";
export const FREE_RUN_KEY = "gridiron-immortals.freeRun.v1";

export interface Unlock {
  unlocked: true;
  /** When this device unlocked, ms since epoch. */
  at: number;
  /** The checkout reference it unlocked with, when it came from `/unlock`. */
  sessionId: string | null;
  /** Always false in this build: there is no server-side verification. */
  verified: false;
}

const readRaw = (key: string): string | null => {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeRaw = (key: string, value: string): boolean => {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    // Private mode / quota: the game still plays, the device just forgets.
    return false;
  }
};

/* ---------------------------------------------------------------- the unlock */

const isUnlock = (value: unknown): value is Unlock => {
  if (typeof value !== "object" || value === null) return false;
  const unlock = value as Partial<Unlock>;
  return (
    unlock.unlocked === true &&
    typeof unlock.at === "number" &&
    (unlock.sessionId === null || typeof unlock.sessionId === "string") &&
    unlock.verified === false
  );
};

/** The stored unlock, or null. Anything malformed counts as not unlocked. */
export const readUnlock = (): Unlock | null => {
  const raw = readRaw(UNLOCK_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isUnlock(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * Synchronous entitlement check. Safe to call from an event handler (the gate
 * in `startRun` does), and safe on the server — it just returns false there.
 *
 * THE STORE BUILD IS ALWAYS UNLOCKED: the app was paid for before it was
 * installed, so there is no per-device state to read. Nothing is written to
 * storage to arrange this — the answer does not depend on storage at all.
 */
export const isUnlocked = (): boolean => (STORE_BUILD ? true : readUnlock() !== null);

/**
 * Write the unlock for this device. Only `/unlock` should call this, and only
 * with a reference that passed `isCheckoutSessionId`. `verified` is hard-coded
 * false on purpose — change this comment before you change that.
 */
export const grantUnlock = (sessionId: string | null): Unlock => {
  const unlock: Unlock = {
    unlocked: true,
    at: Date.now(),
    sessionId,
    verified: false,
  };
  writeRaw(UNLOCK_KEY, JSON.stringify(unlock));
  return unlock;
};

/* --------------------------------------------------------------- free run */

/**
 * Has this device finished a run? The flag is written when a season finishes —
 * never when one starts, so a reload can't burn the allowance and a player is
 * never ambushed mid-draft.
 *
 * THE STORE BUILD HAS NO FREE RUN TO SPEND, so this is false for every device
 * forever. That is deliberate and load-bearing: the game's gate refuses a start
 * only when a device is unpaid AND has finished a run, so "always false" is what
 * lets a fresh install start a run immediately and run it back as often as it
 * likes.
 */
export const hasFinishedARun = (): boolean => (STORE_BUILD ? false : readRaw(FREE_RUN_KEY) !== null);

/** Called once, at the finish of a season. Idempotent by construction. */
export const markFreeRunUsed = (): void => {
  // Nothing to mark in a paid download: no allowance exists, so no allowance is
  // spent, and the device is not left holding a flag that means nothing here.
  if (STORE_BUILD) return;
  if (hasFinishedARun()) return;
  writeRaw(FREE_RUN_KEY, JSON.stringify({ at: Date.now() }));
};

/* -------------------------------------------------------------------- hook */

export interface Entitlement {
  /** False until the client has read storage; keeps SSR and first render equal. */
  loaded: boolean;
  unlocked: boolean;
  freeRunUsed: boolean;
}

const UNLOADED: Entitlement = { loaded: false, unlocked: false, freeRunUsed: false };

/**
 * Read the entitlement after mount, so the server-rendered markup and the first
 * client pass agree. Callers that gate an action must still call `isUnlocked()`
 * directly in the handler — this is for rendering, not for decisions.
 */
export const useEntitlement = (): Entitlement => {
  const [state, setState] = useState<Entitlement>(UNLOADED);

  useEffect(() => {
    const read = (): void => {
      setState({ loaded: true, unlocked: isUnlocked(), freeRunUsed: hasFinishedARun() });
    };
    read();
    // Another tab unlocking the game should unhide the panels without a reload.
    window.addEventListener("storage", read);
    return () => window.removeEventListener("storage", read);
  }, []);

  return state;
};

/* --------------------------------------------------------- checkout refs */

/**
 * Stripe Checkout session references look like `cs_live_<base62>` (or
 * `cs_test_…` in test mode). This is a *shape* check: it proves the string is
 * plausibly a checkout reference and nothing more. Accepting it is a claim, not
 * a verification, and the copy must never pretend otherwise.
 */
const SESSION_ID_PATTERN = /^cs_(?:live|test)_[A-Za-z0-9]{6,200}$/;

export const isCheckoutSessionId = (value: string): boolean =>
  SESSION_ID_PATTERN.test(value.trim());

/** The names Stripe's redirect can use, in the order we prefer them. */
export const SESSION_PARAMS = ["session_id", "session", "checkout_session_id"] as const;

/** Pull the checkout reference out of a query string, or null. */
export const checkoutRefFrom = (search: string): string | null => {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return null;
  }
  for (const name of SESSION_PARAMS) {
    const value = params.get(name);
    if (value && value.trim().length > 0) return value.trim();
  }
  return null;
};
