/**
 * Gridiron Immortals — device-local run history (localStorage only).
 * No accounts, no server, no database: a run is saved on the phone that played it.
 */
import type { DraftedPlayer } from "~/lib/game";

export interface StoredRun {
  id: string;
  finishedAt: number;
  wins: number;
  losses: number;
  undefeated: boolean;
  overall: number;
  roster: DraftedPlayer[];
}

const KEY = "gridiron-immortals.runs.v1";
const MAX_RUNS = 20;

const isStoredRun = (value: unknown): value is StoredRun => {
  if (typeof value !== "object" || value === null) return false;
  const run = value as Partial<StoredRun>;
  return (
    typeof run.id === "string" &&
    typeof run.wins === "number" &&
    typeof run.losses === "number" &&
    typeof run.undefeated === "boolean" &&
    Array.isArray(run.roster)
  );
};

export const loadRuns = (): StoredRun[] => {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredRun).sort((a, b) => b.finishedAt - a.finishedAt);
  } catch {
    return [];
  }
};

export const saveRun = (run: StoredRun): StoredRun[] => {
  const runs = [run, ...loadRuns()].slice(0, MAX_RUNS);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(runs));
    } catch {
      // Private mode / quota: history is a nice-to-have, the run still counts.
    }
  }
  return runs;
};

export const clearRuns = (): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
};

/** Best result so far: most wins, then best roster rating. */
export const bestRun = (runs: StoredRun[]): StoredRun | null => {
  if (runs.length === 0) return null;
  return runs.reduce((best, run) =>
    run.wins > best.wins || (run.wins === best.wins && run.overall > best.overall) ? run : best,
  );
};

export const newRunId = (): string =>
  `run_${String(Date.now())}_${Math.floor(Math.random() * 100000).toString(36)}`;

/**
 * Which local runs were already sent to the global board, so the result screen
 * can say so (and can't be talked into submitting the same run twice). Keyed by
 * local run id; purely a convenience, never a source of truth.
 */
export interface BoardSubmission {
  runId: string;
  name: string;
  rank: number;
  total: number;
  at: number;
}

const SUBMITTED_KEY = "gridiron-immortals.submitted.v1";
const MAX_SUBMITTED = 50;

export const loadSubmissions = (): Record<string, BoardSubmission> => {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(SUBMITTED_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, BoardSubmission>;
  } catch {
    return {};
  }
};

export const saveSubmission = (submission: BoardSubmission): void => {
  if (typeof window === "undefined") return;
  try {
    const all = loadSubmissions();
    all[submission.runId] = submission;
    const trimmed = Object.values(all)
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_SUBMITTED);
    const next: Record<string, BoardSubmission> = {};
    for (const item of trimmed) next[item.runId] = item;
    window.localStorage.setItem(SUBMITTED_KEY, JSON.stringify(next));
  } catch {
    // Private mode / quota: the submission already landed server-side.
  }
};

/* ------------------------------------------------------- board identity */

/**
 * The player's display name, remembered on the device so a run never needs a
 * submit tap again. `posting: false` is the opt-out — the name stays, nothing
 * is sent. Absent means the player has never given a name, which is when the
 * result screen shows the first-time manual form.
 */
export interface BoardIdentity {
  name: string;
  posting: boolean;
  at: number;
}

const IDENTITY_KEY = "gridiron-immortals.identity.v1";

export const loadIdentity = (): BoardIdentity | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(IDENTITY_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const value = parsed as Partial<BoardIdentity>;
    if (typeof value.name !== "string" || value.name.trim().length === 0) return null;
    return {
      name: value.name,
      posting: value.posting !== false,
      at: typeof value.at === "number" ? value.at : 0,
    };
  } catch {
    return null;
  }
};

export const saveIdentity = (identity: BoardIdentity): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  } catch {
    // Private mode / quota: posting still works for this run.
  }
};

/** Remember a name (first-time submit) or flip the opt-out without losing it. */
export const rememberName = (name: string, posting = true): BoardIdentity => {
  const next: BoardIdentity = { name, posting, at: Date.now() };
  saveIdentity(next);
  return next;
};

export const setPosting = (identity: BoardIdentity, posting: boolean): BoardIdentity => {
  const next: BoardIdentity = { name: identity.name, posting, at: Date.now() };
  saveIdentity(next);
  return next;
};

/* ------------------------------------------------------------ device token */

/**
 * The hidden device token: half of a players-board identity (the display name
 * is the other, visible, half). It is created the first time the game runs on a
 * device, lives only in localStorage, and is sent with every submission.
 *
 * It is NOT a login and NOT a secret we can verify — clearing site data starts
 * a fresh identity, and a determined player can mint identities at will. That is
 * the documented cost of having no accounts, and it is the honest limit of what
 * this board can promise. What it does buy: two phones that both call
 * themselves "John" stay two players, and one phone keeps one rating.
 */
const DEVICE_KEY = "gridiron-immortals.device.v1";
const TOKEN_BYTES = 16;
const TOKEN_FALLBACK_LENGTH = 32;
const HEX = "0123456789abcdef";

const randomToken = (): string => {
  try {
    const bytes = new Uint8Array(TOKEN_BYTES);
    window.crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    // Very old browser or a locked-down context: still a usable random string.
    let out = "";
    for (let i = 0; i < TOKEN_FALLBACK_LENGTH; i += 1) {
      out += HEX[Math.floor(Math.random() * HEX.length)];
    }
    return out;
  }
};

/** The stored token, or null if this device has never played. */
export const loadDeviceToken = (): string | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(DEVICE_KEY);
    if (!raw || !/^[a-z0-9]{16,64}$/i.test(raw)) return null;
    return raw.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * The token, creating and persisting one on first call. Falls back to a
 * throwaway token when storage is unavailable (private mode), so a run still
 * gains a rating for the session rather than failing.
 */
export const ensureDeviceToken = (): string => {
  const existing = loadDeviceToken();
  if (existing) return existing;
  const created = randomToken();
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(DEVICE_KEY, created);
    } catch {
      // Private mode / quota: the token is per-session, the game still works.
    }
  }
  return created;
};
