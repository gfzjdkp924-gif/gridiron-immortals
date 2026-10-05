/**
 * Gridiron Immortals — the players board's SQL, as text (SERVER ONLY).
 *
 * Same discipline as src/lib/leaderboard-sql.ts: plain strings executed with
 * `sql.query(text, params)`, so tools/players-check.ts can run the REAL
 * statements against a real Postgres engine (PGlite) while DATABASE_URL is
 * still missing. Every statement is idempotent.
 *
 * One row per game player, keyed by device token. The table stores a TALLY, not
 * a rating that anyone can send: a season arrives as one row's worth of
 * (score, wins, losses) and the UPDATE derives the new average from the previous
 * row. `rating_sum` is the exact total and `rating` its rounded average, so the
 * board can be ranked from a stored column (indexable) while the arithmetic
 * stays exact.
 */

export const CREATE_PLAYERS_TABLE_SQL = `
create table if not exists gridiron_players (
  device_token text primary key,
  name text not null,
  seasons integer not null default 0,
  rating_sum numeric(12,2) not null default 0,
  rating numeric(7,2) not null default 0,
  wins integer not null default 0,
  losses integer not null default 0,
  best_wins integer not null default 0,
  best_losses integer not null default 0,
  best_overall numeric(5,1) not null default 0,
  perfect_seasons integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)
`;

/**
 * Supports the board's ORDER BY exactly: rating desc, then the tiebreaks
 * (more seasons = more proven, then the best single record, then who joined
 * first, then the token so the order is total).
 *
 * Deliberately NOT partial on `seasons >= MIN_SEASONS`: the minimum is a
 * business rule that may move, and a plain index still serves the
 * `where seasons >= n order by rating desc …` query.
 */
export const CREATE_PLAYERS_INDEX_SQL = `
create index if not exists gridiron_players_board_idx
  on gridiron_players (rating desc, seasons desc, best_wins desc, created_at asc, device_token asc)
`;

/**
 * Record ONE completed season for one identity, atomically, in a single
 * statement — no read-then-write race between two devices (or two seasons
 * finishing at once).
 *
 * The VALUES row is that single season's contribution: seasons = 1, rating_sum
 * = this season's score, wins/losses = this season's record, best_* = this
 * season's record. On conflict the new row is folded into the old one:
 *
 *   seasons      old + 1
 *   rating_sum   old + this season's score      → rating = round(sum/seasons, 2)
 *   wins/losses  running totals
 *   best_*       this season only when it is strictly the best record so far
 *                (more wins, or equal wins with a better roster rating)
 *   name         the latest display name — a label, not an identity
 *
 * `excluded` refers to the VALUES row (this season), `p` to the stored row
 * (everything before it). Nothing here reads a client-supplied rating, delta or
 * total: every input is a server-derived number.
 */
export const UPSERT_SEASON_SQL = `
insert into gridiron_players as p (
  device_token, name, seasons, rating_sum, rating, wins, losses,
  best_wins, best_losses, best_overall, perfect_seasons, created_at, updated_at
)
values (
  $1, $2, 1, $3::numeric, round($3::numeric, 2), $4, $5,
  $4, $5, $6::numeric, $7::int, now(), now()
)
on conflict (device_token) do update set
  name = excluded.name,
  seasons = p.seasons + 1,
  rating_sum = p.rating_sum + excluded.rating_sum,
  rating = round((p.rating_sum + excluded.rating_sum) / (p.seasons + 1), 2),
  wins = p.wins + excluded.wins,
  losses = p.losses + excluded.losses,
  best_wins = case
    when excluded.best_wins > p.best_wins
      or (excluded.best_wins = p.best_wins and excluded.best_overall > p.best_overall)
    then excluded.best_wins else p.best_wins end,
  best_losses = case
    when excluded.best_wins > p.best_wins
      or (excluded.best_wins = p.best_wins and excluded.best_overall > p.best_overall)
    then excluded.best_losses else p.best_losses end,
  best_overall = greatest(p.best_overall, excluded.best_overall),
  perfect_seasons = p.perfect_seasons + excluded.perfect_seasons,
  updated_at = now()
returning name, seasons, rating, rating_sum, wins, losses,
          best_wins, best_losses, best_overall, perfect_seasons, created_at, updated_at
`;

/** Column list shared by the board read and the single-identity read. */
const PLAYER_COLUMNS = `device_token, name, seasons, rating, wins, losses,
  best_wins, best_losses, best_overall, perfect_seasons, created_at, updated_at`;

/**
 * The players board. $1 = row cap, $2 = minimum seasons. The ORDER BY is the
 * contract, mirrored by comparePlayers() in src/lib/player-rating.ts.
 */
export const RANKED_PLAYERS_SQL = `
select ${PLAYER_COLUMNS}
from gridiron_players
where seasons >= $2
order by rating desc, seasons desc, best_wins desc, created_at asc, device_token asc
limit $1
`;

/** Players who have finished enough seasons to be ranked. */
export const COUNT_PLAYERS_SQL = `select count(*)::int as total from gridiron_players where seasons >= $1`;

/** Every identity, ranked or not — shown to the player as context. */
export const COUNT_IDENTITIES_SQL = `select count(*)::int as total from gridiron_players`;

/**
 * One identity's own row, whether or not it has cleared the seasons gate, so the
 * board can say "you, 2 seasons, 1 to go".
 */
export const PLAYER_BY_TOKEN_SQL = `
select ${PLAYER_COLUMNS}
from gridiron_players
where device_token = $1
`;

/**
 * That identity's position when it HAS cleared the gate, computed with the
 * board's own ordering so the number on screen is the number on the board.
 * Returns no row for an identity below the gate.
 */
export const PLAYER_RANK_SQL = `
select r.rank
from (
  select device_token,
         row_number() over (
           order by rating desc, seasons desc, best_wins desc, created_at asc, device_token asc
         ) as rank
  from gridiron_players
  where seasons >= $2
) r
where r.device_token = $1
`;

/** Statements that must exist before any read or write. Run in order. */
export const PLAYERS_SCHEMA_STATEMENTS = [
  CREATE_PLAYERS_TABLE_SQL,
  CREATE_PLAYERS_INDEX_SQL,
] as const;
