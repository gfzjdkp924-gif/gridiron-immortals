/**
 * Gridiron Immortals — the client half of the finished-season count.
 *
 * ONE CALL, ONE BOOLEAN, FIRE AND FORGET. When a season finishes, the game tells
 * our server that a season finished, and whether it was the first season this
 * browser has ever finished. That is the entire message (`POST /api/run-count`,
 * src/routes/api/run-count.ts). Nothing else goes with it: no device token, not
 * even the one-way hash of one, no name, no cookie, no id, nothing about the
 * roster, the record or the team that was drawn.
 *
 * WHY THE CLIENT ANSWERS "FIRST". Only the device knows whether it has finished a
 * season before, and it knows it without telling us anything: the local run
 * history (src/lib/storage.ts) and the free-run flag (src/lib/entitlement.ts).
 * Reading that flag and *then* sending one word is what makes "how many people
 * played for the first time" countable without identifying anybody.
 *
 * COUNTING NEVER COSTS A PLAYER ANYTHING. The call is made after the run is
 * already saved on the device, its promise is swallowed, and there is no retry:
 * a slow, blocked, offline or broken counter cannot delay the result screen, show
 * an error, or keep a run from saving. Offline play is untouched — the request
 * fails and nothing happens. That is also why nothing here is awaited: this file
 * exports a `void` function on purpose.
 *
 * IT IS NOT GATED ON PAYING. The first run is free, and the free run is the
 * number that matters most (see the business plan's KPIs), so the count fires for
 * every finished season, unlocked or not, posted or not. The posting opt-out is
 * about a display name becoming public, and this request carries no name, so it
 * does not suppress the count either.
 */
import { apiUrl } from "~/lib/api-base";
import { hasFinishedARun } from "~/lib/entitlement";
import { loadRuns } from "~/lib/storage";
import { RUN_COUNT_PATH, countBody } from "~/lib/run-stats";

export { RUN_COUNT_PATH };

/**
 * Has this browser ever finished a season? Asked BEFORE the run is marked as
 * finished, so it answers for the season that is ending right now.
 *
 * Two sources, both device-local, either of which is enough to say "not the
 * first": the free-run flag (written when a season finishes, never when one
 * starts) and the saved-run history. They are used together because the game's
 * own "clear history" button empties the second and is not meant to mint a new
 * first run — a returning player who tidied their history is still returning.
 *
 * On the server (no window) this is false: nothing is counted during SSR.
 */
export const isFirstFinishedRun = (): boolean => {
  if (typeof window === "undefined") return false;
  try {
    if (hasFinishedARun()) return false;
    return loadRuns().length === 0;
  } catch {
    // Storage unavailable (private mode): treat it as "not the first", which
    // undercounts rather than inventing first-time players.
    return false;
  }
};

/**
 * Count one finished season. Returns nothing, waits for nothing, throws nothing.
 *
 * `keepalive` matters here: it lets the browser finish the request even if the
 * player navigates away in the same moment. A failure — offline, a 429, a
 * server with no store — is not reported to anyone, including us: this number is
 * not worth an error message to a player who just went 17-0.
 */
export const countFinishedRun = (first: boolean): void => {
  if (typeof window === "undefined") return;
  try {
    void fetch(apiUrl(RUN_COUNT_PATH), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: countBody(first),
      keepalive: true,
    })
      .then((response) => {
        // Drained, never inspected: there is no state for a reply to change.
        void response.arrayBuffer().catch(() => undefined);
      })
      .catch(() => undefined);
  } catch {
    // A browser that will not even start the request: the run is already saved.
  }
};
