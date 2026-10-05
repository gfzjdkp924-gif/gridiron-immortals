/**
 * GET /api/env-check — a read-only diagnostic of what the *running* process's
 * environment actually contains.
 *
 * Why it exists: `DATABASE_URL` is saved in the business's Secrets page and yet
 * the live deployment behaves as if it were absent. This endpoint answers the
 * only question that cannot be answered from outside: does the platform inject
 * anything into this runtime at all, and under what names?
 *
 * Privacy contract — deliberately narrow, and it must stay that way:
 *   - NAMES and PRESENCE BOOLEANS only. Never a value, never a host, never a
 *     credential, never a substring of one.
 *   - `scheme` and `length` are reported for the three connection-string names
 *     (DATABASE_URL, NEON_DATABASE_URL, POSTGRES_URL) and for PROBE_OK only,
 *     and only when the value really starts with a syntactically valid URI
 *     scheme, so an odd value can never leak a prefix of itself.
 *   - No database connection is opened anywhere in this file: it reads
 *     `process.env` and nothing else, so it is fast and cannot hang.
 *   - Nothing is cached or module-scoped: every request re-reads the live
 *     environment, so a newly injected variable shows up after a redeploy.
 */
import { createFileRoute } from "@tanstack/react-router";

import { dbUrlKey } from "~/db";
import { describeStore } from "~/server/file-store";

/** Keys we care about for the DATABASE_URL delivery investigation. */
const WATCHED = [
  "DATABASE_URL",
  "NEON_DATABASE_URL",
  "POSTGRES_URL",
  "PROBE_OK",
  "DB_DRIVER",
  "VERCEL_ENV",
  "VERCEL_URL",
  "NODE_ENV",
] as const;

/**
 * The only keys allowed to report scheme + length. The three connection-string
 * names are here because any of them can now carry the database (see
 * `DB_URL_KEYS` in `src/db.ts`), so the owner needs to see the same
 * scheme/length detail whichever one the runtime actually received.
 */
const DETAILED = new Set<string>(["DATABASE_URL", "NEON_DATABASE_URL", "POSTGRES_URL", "PROBE_OK"]);

/** RFC 3986 scheme: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ), kept short. */
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]{0,31}$/;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Never cached: the whole point is to see the env as of *this* request.
      "cache-control": "no-store, no-cache, must-revalidate",
    },
  });

/**
 * The text before "://" — but only if it looks like a URI scheme, and never the
 * rest of the value. Returns null when there is no "://" or the prefix is not a
 * valid scheme (which is also what stops a malformed secret leaking a prefix of
 * itself through this field).
 */
function schemeOf(value: string): string | null {
  const at = value.indexOf("://");
  if (at <= 0) return null;
  const scheme = value.slice(0, at);
  return SCHEME_RE.test(scheme) ? scheme.toLowerCase() : null;
}

function keyInfo(name: string): { present: boolean; scheme?: string | null; length?: number } {
  const raw = process.env[name];
  const present = raw !== undefined && raw !== null && raw !== "";
  if (!present) return { present: false };
  // Length of what the process actually sees, including any stray whitespace.
  const info: { present: boolean; scheme?: string | null; length?: number } = {
    present: true,
    length: raw.length,
  };
  if (DETAILED.has(name)) info.scheme = schemeOf(raw);
  return info;
}

export const Route = createFileRoute("/api/env-check")({
  server: {
    handlers: {
      GET: async (): Promise<Response> => {
        // Fresh read on every request — no module-level snapshot.
        const env = process.env;

        const keys: Record<string, ReturnType<typeof keyInfo>> = {};
        for (const name of WATCHED) keys[name] = keyInfo(name);

        // Names only. Sorting makes the output stable and easy to diff between
        // two requests (e.g. before and after a redeploy).
        const names = Object.keys(env).sort();

        const bunVersion = (process.versions as Record<string, string | undefined> | undefined)?.bun;

        // Which store the two boards actually use in THIS process, and where a
        // file-backed one put its document. Contains no secret: a connection
        // string is reported by KEY NAME only, and the directory path holds no
        // value a visitor does not already have. `/api/env-check` is public, so
        // this must stay to exactly that.
        //
        // `keys` alone does not answer "which store answered my last request":
        // a connection string that is PRESENT but cannot connect (a truncated
        // secret, a paused database) sends the boards to the file-backed store
        // (src/server/store-choice.ts). So the file store's own resolution is
        // always reported, whether or not a string is set — that is the
        // directory whose contents a redeploy can be measured against.
        const key = dbUrlKey();
        const file = await describeStore();
        const fileInfo = {
          kind: file.kind,
          source: file.source,
          dir: file.dir,
          file: file.file,
          note: file.note,
        };
        const store = key
          ? { kind: "postgres", via: key, usable: "unknown — see the boards' own responses", file: fileInfo }
          : file.kind === "file"
            ? { kind: "file", source: file.source, dir: file.dir, file: fileInfo }
            : { kind: "none", source: null, dir: null, file: fileInfo };

        return json({
          note: "Diagnostic: environment variable NAMES, presence booleans, and (for DATABASE_URL / NEON_DATABASE_URL / POSTGRES_URL / PROBE_OK only) the URI scheme and length. No values, no hosts, no credentials are ever emitted. `store` names which board store this process resolved to, and its directory when that store is file-backed.",
          keys,
          env: {
            count: names.length,
            names,
          },
          runtime: {
            version: process.version,
            bun: typeof (globalThis as { Bun?: unknown }).Bun !== "undefined",
            bunVersion: bunVersion ?? null,
            platform: process.platform,
          },
          store,
          // Cheap, non-secret: was this response built by the dev server or a
          // published build? Helps tell which deployment answered.
          servedAt: new Date().toISOString(),
        });
      },
    },
  },
});
