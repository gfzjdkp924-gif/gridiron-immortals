/**
 * Gridiron Immortals — the server-only database handle (SERVER ONLY).
 *
 * The owner may connect either kind of Postgres, so this module speaks both:
 *
 *   1. **Neon serverless HTTP** — `postgresql://…@ep-xxx.region.aws.neon.tech/db`,
 *      served by the Neon HTTP driver (`@neondatabase/serverless`), which posts
 *      each statement to the host's `/sql` endpoint. No TCP socket is held.
 *   2. **An ordinary `postgres://…` URL** from any classic host (Tiger Cloud,
 *      Supabase's direct connection, a self-hosted server, a local Postgres) —
 *      served by `pg` (node-postgres) over a real TCP socket with a small,
 *      lazily-created connection pool.
 *
 * Which one is used is decided from the connection string's HOST, once per
 * process: a `…neon.tech` host gets the HTTP driver, everything else gets TCP.
 * `DB_DRIVER=http|tcp|auto` (default `auto`) overrides that if a host is ever
 * unusual — including pointing a Neon URL at the TCP driver, which Neon also
 * serves on port 5432.
 *
 * Everything is resolved lazily, on the first query, never at module load:
 * with no connection string set the module still imports cleanly, the site
 * builds, and both boards answer "not connected" — a missing database is a
 * state, not an error. Nothing here reaches for `pg` or a socket until a query
 * runs.
 *
 * The connection string may arrive under any of `DATABASE_URL`,
 * `NEON_DATABASE_URL` or `POSTGRES_URL` — the first one set wins, in that
 * order (see `DB_URL_KEYS`). `DATABASE_URL` is the canonical name; the other
 * two are fallbacks for when a secret row under that name will not persist in
 * the platform's Secrets page. The server log line names the key a fallback
 * value came from and stays byte-for-byte unchanged for `DATABASE_URL`.
 *
 * The returned handle keeps the API the boards already use:
 *
 *   const rows = await sql().query(SOME_SQL, [param]);   // array of rows
 *   const rows = await sql()`select id from posts`;       // tagged template
 *
 * Rows are returned as a plain array in both transports (Neon's HTTP driver
 * already does; `pg`'s `Result` object is unwrapped to `.rows` here), so no
 * call site needs to know which database is behind it.
 *
 * NOTE for callers: `numeric`/`bigint` columns come back as strings and
 * `timestamptz` as a JS `Date`, whichever transport is used. Coerce
 * non-primitive columns before returning them to the client.
 */

export type DbTransport = "http" | "tcp";

/** Row shape both transports are normalised to. */
export type DbRow = Record<string, unknown>;

/** The handle `sql()` returns: queryable, and callable as a tagged template. */
export interface Db {
  (strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<DbRow[]>;
  query(text: string, params?: readonly unknown[]): Promise<DbRow[]>;
  /** Which transport this handle resolved to — logged and used by tests. */
  readonly transport: DbTransport;
  /** Hostname only, never the credentials — safe to log. */
  readonly host: string;
}

/** Hosts whose `/sql` HTTP endpoint we can use instead of a TCP socket. */
const HTTP_HOST_SUFFIXES = ["neon.tech"];

/**
 * The environment keys that may carry the connection string, in the order they
 * are tried. `DATABASE_URL` is the canonical one (the name the platform's
 * database card and every provider's dashboard use); the other two exist
 * because a secret row under one name can fail to persist in the platform's
 * Secrets page while another name saves fine — so the same database can be
 * connected under whichever name actually arrives in the runtime.
 *
 * Order is fixed and first-match-wins: `DATABASE_URL` always wins when it is
 * set, so the canonical path is unchanged, and the fallbacks are additive.
 */
export const DB_URL_KEYS = ["DATABASE_URL", "NEON_DATABASE_URL", "POSTGRES_URL"] as const;

export type DbUrlKey = (typeof DB_URL_KEYS)[number];

/**
 * The connection string this process should use, plus which key supplied it.
 * Resolved lazily and freshly on every call (never memoised at module load), so
 * a secret that appears after a restart is picked up and a changed value never
 * reuses a stale client.
 *
 * A key counts only when its value is non-empty — the same definition the
 * diagnostic endpoint reports and the same one `DATABASE_URL` alone had before,
 * so an empty `DATABASE_URL=""` behaves exactly as it used to.
 *
 * Returns null when none of the three is set: the caller then reports "not
 * connected" without touching a driver, a socket or a URL parser.
 */
export const resolveDbUrl = (): { key: DbUrlKey; value: string } | null => {
  for (const key of DB_URL_KEYS) {
    const value = process.env[key];
    if (value) return { key, value };
  }
  return null;
};

/**
 * Which key supplied the connection string, or null when none did. Names only —
 * safe to log.
 */
export const dbUrlKey = (): DbUrlKey | null => resolveDbUrl()?.key ?? null;

/**
 * True when a connection string is present at all. Cheap enough to call on the
 * read path: it lets every board answer "not connected" without ever touching a
 * driver, a socket or a URL parser, so a missing database is a state, not an
 * error.
 */
export const dbConfigured = (): boolean => resolveDbUrl() !== null;

/**
 * Log-line suffix naming the key a connection string came from, e.g.
 * ` (via NEON_DATABASE_URL)`.
 *
 * Empty for `DATABASE_URL`: when the canonical key is the one that supplied it,
 * the log line is byte-for-byte what it was before the fallbacks existed, and
 * an un-annotated line means `DATABASE_URL`. A fallback key is always named, so
 * there is never any doubt which row the owner's database arrived under.
 */
const viaSuffix = (key: DbUrlKey): string => (key === "DATABASE_URL" ? "" : ` (via ${key})`);

/** `…neon.tech` (and its subdomains) serve the Neon HTTP protocol. */
export const isHttpHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase();
  return HTTP_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
};

/**
 * The transport for one connection string. Reads the `DB_DRIVER` override first
 * (`http`, `tcp`, or `auto`/unset = decide from the host), so an operator can
 * pin a transport without a code change.
 *
 * A string that is not a parseable URL falls through to `tcp`, which produces
 * the clearer error ("the connection string is not a URL") and keeps a typo
 * from silently being treated as an HTTP endpoint.
 */
export const transportFor = (raw: string, override = process.env.DB_DRIVER): DbTransport => {
  const wanted = (override ?? "").trim().toLowerCase();
  if (wanted === "http" || wanted === "neon") return "http";
  if (wanted === "tcp" || wanted === "postgres" || wanted === "pg") return "tcp";
  try {
    return isHttpHost(new URL(raw).hostname) ? "http" : "tcp";
  } catch {
    return "tcp";
  }
};

/**
 * TLS for the TCP client, following libpq's `sslmode` meanings so a connection
 * string pasted straight from a provider's dashboard behaves as its own docs
 * promise:
 *
 *   `sslmode=disable`                     → no TLS
 *   `sslmode=verify-ca` / `verify-full`   → TLS, certificate verified
 *   `sslmode=require` / `prefer` / `allow`→ TLS, certificate NOT verified
 *   no `sslmode`, remote host             → TLS, certificate NOT verified
 *   no `sslmode`, loopback host           → no TLS
 *
 * `rejectUnauthorized: false` is libpq's `require`: the connection is encrypted
 * but the chain is not checked. That is what a managed provider's own URL means
 * by `sslmode=require`, and it is the setting that works whether or not the
 * chain happens to validate from this box. A provider whose URL asks for
 * verification (`verify-full`) still gets it.
 */
export const sslFor = (url: URL): false | { rejectUnauthorized: boolean } => {
  const mode = (url.searchParams.get("sslmode") ?? "").trim().toLowerCase();
  if (mode === "disable") return false;
  if (mode === "verify-ca" || mode === "verify-full") return { rejectUnauthorized: true };
  if (mode) return { rejectUnauthorized: false };
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback =
    host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local");
  return loopback ? false : { rejectUnauthorized: false };
};

/**
 * Just the hostname, for logging and diagnostics. Never returns credentials, so
 * the result is safe to print. Unparseable strings say so instead of throwing —
 * this is called on the error path too.
 */
export const hostOf = (raw: string): string => {
  try {
    return new URL(raw).hostname;
  } catch {
    return "unparseable-url";
  }
};

/** Build `{ text, params }` from a tagged template, for the callable form. */
export const buildTagged = (
  strings: readonly string[],
  values: readonly unknown[],
): { text: string; params: unknown[] } => {
  let text = strings[0] ?? "";
  const params: unknown[] = [];
  for (let index = 0; index < values.length; index += 1) {
    text += `$${String(index + 1)}${strings[index + 1] ?? ""}`;
    params.push(values[index]);
  }
  return { text, params };
};

/* ----------------------------------------------------------------- transport
 * Both clients are memoised per process and keyed by the connection string, so
 * a change of `DATABASE_URL` (the owner reconnects a database; the live site
 * restarts with the new value seconds later) never reuses a stale client.
 */
type HttpQuery = (text: string, params: readonly unknown[]) => Promise<unknown>;
let httpClient: { query: HttpQuery } | null = null;
let httpKey = "";

// `pg`'s Pool, typed structurally to avoid a runtime import of its types.
interface TcpPool {
  query: (text: string, params?: readonly unknown[]) => Promise<{ rows: DbRow[] }>;
  on: (event: "error", listener: (error: Error) => void) => void;
}
let tcpPool: TcpPool | null = null;
let tcpKey = "";

/** The connection string whose transport has already been logged. */
let loggedKey = "";

const queryHttp = async (raw: string, text: string, params: readonly unknown[]): Promise<DbRow[]> => {
  if (!httpClient || httpKey !== raw) {
    const { neon } = await import("@neondatabase/serverless");
    httpClient = neon(raw) as unknown as { query: HttpQuery };
    httpKey = raw;
  }
  const result: unknown = await httpClient.query(text, params);
  return Array.isArray(result) ? (result as DbRow[]) : [];
};

const createTcpPool = async (raw: string, key: DbUrlKey): Promise<TcpPool> => {
  const { Pool } = await import("pg");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `${key} is not a valid connection string — expected something like postgresql://user:password@host:5432/dbname`,
    );
  }
  const pool = new Pool({
    connectionString: raw,
    ssl: sslFor(url),
    // Three sockets is plenty for a game board, and it keeps the footprint on a
    // free-plan Postgres (which caps concurrent connections) small.
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
    application_name: "gridiron-immortals",
  }) as unknown as TcpPool;
  // Without this listener a dropped idle connection raises an unhandled 'error'
  // event, which kills the whole server process. The boards' own try/catch
  // handles it as "not connected" instead.
  pool.on("error", (error: unknown) => {
    console.error(
      "[db] idle postgres client error:",
      error instanceof Error ? error.message : String(error),
    );
  });
  return pool;
};

const queryTcp = async (
  raw: string,
  key: DbUrlKey,
  text: string,
  params: readonly unknown[],
): Promise<DbRow[]> => {
  if (!tcpPool || tcpKey !== raw) {
    tcpPool = await createTcpPool(raw, key);
    tcpKey = raw;
  }
  // A parameterless statement goes over the simple query protocol, so
  // multi-statement schema strings and DDL behave exactly as written.
  const result = params.length
    ? await tcpPool.query(text, params)
    : await tcpPool.query(text);
  return Array.isArray(result.rows) ? result.rows : [];
};

/**
 * The database handle. Throws only when no connection string is set — the two
 * server modules guard with `dbConfigured()` first, so in practice this is
 * reached only when a database HAS been connected.
 *
 *   const rows = await sql().query(RANKED_BOARD_SQL, [MAX_BOARD]);
 */
export const sql = (): Db => {
  const resolved = resolveDbUrl();
  if (!resolved) {
    throw new Error(
      `None of ${DB_URL_KEYS.join(" / ")} is set — connect a database (via the database card) before running queries.`,
    );
  }
  const { key, value: raw } = resolved;
  const transport = transportFor(raw);
  const host = hostOf(raw);
  // One line per process (per connection string) so the server log says which
  // transport the owner's database actually went down — and which secret name
  // supplied it — without printing a line for every query.
  const memo = `${key}\u0000${raw}`;
  if (loggedKey !== memo) {
    loggedKey = memo;
    console.log(`[db] ${transport} transport → ${host}${viaSuffix(key)}`);
  }
  const run = (text: string, params: readonly unknown[]): Promise<DbRow[]> =>
    transport === "http" ? queryHttp(raw, text, params) : queryTcp(raw, key, text, params);
  const tagged = (
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<DbRow[]> => {
    const { text, params } = buildTagged(strings, values);
    return run(text, params);
  };
  return Object.assign(tagged, {
    query: (text: string, params: readonly unknown[] = []): Promise<DbRow[]> => run(text, params),
    transport,
    host,
  });
};

/** Diagnostic line for the server log: which transport and host a URL resolves to. */
export const describeDb = (): string => {
  const resolved = resolveDbUrl();
  if (!resolved) return "no connection string — both boards report 'not connected'";
  return `${transportFor(resolved.value)} transport → ${hostOf(resolved.value)}${viaSuffix(resolved.key)}`;
};
