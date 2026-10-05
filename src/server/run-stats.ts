/**
 * Gridiron Immortals — the finished-season counters, read and written (SERVER
 * ONLY). The numbers themselves and every rule about them live in
 * src/lib/run-stats.ts; this is only the way in and the way out.
 *
 * WHY THIS DOES NOT ASK WHICH STORE IS ANSWERING. The boards switch between
 * Postgres and the file document (src/server/store-choice.ts), and each answers
 * alone. The counters are not part of that choice: they live in the board
 * document, always (see StoreDoc.stats in src/server/file-store.ts), because
 * that document is the one thing a publish carries forward — a counter written
 * anywhere else is a counter the next redeploy wipes. No connection string is
 * read here, no table is touched, and nothing about this path changes when a
 * database is eventually connected.
 *
 * WHAT A WRITE COSTS A PLAYER: nothing, ever. The client fires the count and
 * forgets it (src/lib/run-count.ts), so a slow or unwritable counter is invisible
 * — the run is already saved on the device by then, and this module's failures
 * are values, never exceptions.
 *
 * NOTE, STATED PLAINLY: if a real Postgres is ever connected, the boards answer
 * from it and the file document stops tracking them — but the counters would
 * keep living in the file and keep being carried forward by
 * tools/board-sync.sh only as far as that document goes (the sync leaves the
 * baked file alone when the database answers, so the counters would then be
 * carried in whole publishes rather than continuously). Persisting them in a
 * table is the honest follow-up if that day comes; today it is not a choice
 * anybody has to make, and this path adds no dependency on it.
 */
import { addFinishedRun, emptyRunStats, type RunStats } from "~/lib/run-stats";
import { readDocument, updateDocument } from "~/server/file-store";

export interface RunStatsReadout {
  /** False when there is nowhere to read the counters from at all. */
  connected: boolean;
  counters: RunStats;
}

/** The counters, as they stand. Never throws, never writes. */
export const readRunStats = async (): Promise<RunStatsReadout> => {
  try {
    const doc = await readDocument();
    if (!doc) return { connected: false, counters: emptyRunStats() };
    return { connected: true, counters: doc.stats };
  } catch {
    return { connected: false, counters: emptyRunStats() };
  }
};

/**
 * ONE finished season. `first` is the client's own answer to "was this the first
 * season this browser had ever finished?" — the only fact a counting request
 * carries, and the only thing that decides whether `firstRuns` moves as well.
 *
 * Returns the counters as written, or null when they could not be written
 * (nowhere writable, or a write that failed). null is not an error the player
 * ever sees: the run is already saved on their device.
 */
export const recordFinishedRun = async (first: boolean, at: Date = new Date()): Promise<RunStats | null> => {
  try {
    const written = await updateDocument((doc) => {
      doc.stats = addFinishedRun(doc.stats, first, at);
      return doc;
    });
    return written ? written.stats : null;
  } catch {
    return null;
  }
};
