/**
 * GET /api/board-export — the board's own document, read out so it can be
 * CARRIED FORWARD into the next deploy.
 *
 * WHY IT EXISTS. The board lives in a file inside the deployed site tree
 * (`<deploy root>/.data/board.json` — see src/server/file-store.ts). That is what
 * makes it survive a publish: the tree, including that file, is re-shipped. The
 * other half of the deal is the step BEFORE a publish: whatever the running game
 * has written since the last one has to get back into the copy we ship, or it is
 * replaced by the older file. `tools/board-sync.sh` does that, and this is the
 * endpoint it reads.
 *
 * WHAT IT RETURNS. The exact document the file store holds — every run and every
 * players-board tally — plus the counts and which store answered. The sync writes
 * `document` verbatim into `.data/board.json`.
 *
 * READ-ONLY AND HARMLESS, deliberately:
 *   - No query parameter changes what it does, and it writes nothing anywhere.
 *   - It never returns a device token: the players board is keyed by a one-way
 *     hash (src/server/player-key.ts), and rows written before that scheme are
 *     re-keyed on load, so the document that leaves here holds hashes only.
 *   - When POSTGRES is the store that answers the boards, there is nothing to
 *     carry forward and the document is `null` with a note saying so — the sync
 *     must never overwrite a good baked file with a read that means nothing.
 *   - With nowhere at all to read from it answers 503 (`ok: false`), which the
 *     sync treats as "do not touch the baked board".
 *   - `cache-control: no-store`, like every other board response.
 */
import { createFileRoute } from "@tanstack/react-router";

import { describeStore, readDocument } from "~/server/file-store";
import { rekeyPlayerRows } from "~/server/player-key";
import { boardsUseDatabase } from "~/server/leaderboard";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate",
    },
  });

export const Route = createFileRoute("/api/board-export")({
  server: {
    handlers: {
      GET: async (): Promise<Response> => {
        const exportedAt = new Date().toISOString();
        try {
          // The same rule the boards follow: a usable database is the live
          // board, and then the file document is not the thing to carry.
          if (await boardsUseDatabase()) {
            return json({
              ok: true,
              exportedAt,
              source: "postgres",
              document: null,
              counts: { runs: 0, players: 0 },
              note: "the boards are answering from the database, so the file document is not the live board and nothing needs carrying forward — leave the baked file alone",
            });
          }
          const store = await describeStore();
          const doc = await readDocument();
          if (!doc) {
            return json(
              {
                ok: false,
                exportedAt,
                source: "none",
                reason: "no-store",
                note: "the file store has nowhere to read from — do NOT overwrite a baked board with this",
              },
              503,
            );
          }
          rekeyPlayerRows(doc.players);
          return json({
            ok: true,
            exportedAt,
            source: store.kind === "file" ? "file" : "none",
            document: doc,
            counts: { runs: doc.runs.length, players: doc.players.length },
            note: "the live board document; tools/board-sync.sh writes this into the site's .data/board.json so the next publish carries it forward",
          });
        } catch (error: unknown) {
          // Never a 500 with a stack trace: an unreadable board is data here.
          return json(
            {
              ok: false,
              exportedAt,
              source: "error",
              reason: "read-failed",
              note: error instanceof Error ? error.message : String(error),
            },
            503,
          );
        }
      },
    },
  },
});
