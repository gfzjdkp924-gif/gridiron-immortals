/**
 * Gridiron Immortals — the leaderboard's SQL, as text.
 *
 * Kept as plain strings (executed with `sql.query(text, params)`) for one
 * reason: the same statements are run against a real Postgres in
 * tools/leaderboard-check.ts, so the schema and the ranking query are verified
 * rather than eyeballed. Only server-only code may import this module.
 *
 * Every statement is idempotent, so `ensureSchema()` can run on any request.
 */

export const CREATE_TABLE_SQL = `
create table if not exists gridiron_runs (
  id bigserial primary key,
  name text not null,
  wins integer not null,
  losses integer not null,
  undefeated boolean not null,
  overall numeric(5,1) not null,
  lineup jsonb not null,
  player_key text,
  created_at timestamptz not null default now()
)
`;

/**
 * Supports the ranking query exactly: wins first, then roster rating, then
 * oldest-first, then id so the order is total (no ties left ambiguous).
 *
 * NOTE the index has its own name. `create index if not exists` would silently
 * keep an older index created under the undefeated-first ordering, and the new
 * query would not be able to use it — so the old index is dropped by name.
 */
export const CREATE_INDEX_SQL = `
create index if not exists gridiron_runs_board_idx
  on gridiron_runs (wins desc, overall desc, created_at asc, id asc)
`;

/** The undefeated-first index from the previous revision, now unused. */
export const DROP_OLD_INDEX_SQL = `drop index if exists gridiron_runs_rank_idx`;

/** Rows older than the columns above (a table created by an earlier revision). */
export const ALTER_ADD_OVERALL_SQL = `
alter table gridiron_runs add column if not exists overall numeric(5,1) not null default 0
`;

/**
 * The identity a run belongs to, so one device's seasons can be read back as
 * that device's profile. It holds the ONE-WAY KEY of the device token
 * (src/server/player-key.ts), never the token itself — exactly what
 * `gridiron_players.device_token` holds, and the same value, so a run and its
 * rating row always agree on who played it.
 *
 * Nullable, and left null for every row written before this column existed: a
 * run that did not record an identity cannot be attributed to one afterwards,
 * and guessing from the display name is precisely what the profile must not do
 * (two phones may share a name).
 */
export const ALTER_ADD_PLAYER_KEY_SQL = `
alter table gridiron_runs add column if not exists player_key text
`;

/** Supports the profile's own read: one device's runs, ranked. */
export const CREATE_PLAYER_KEY_INDEX_SQL = `
create index if not exists gridiron_runs_player_idx on gridiron_runs (player_key)
`;

/**
 * The ranking query — the ORDER BY is the contract (see lib/leaderboard.ts).
 * Every completed season is ranked on one board: more wins first, then the
 * better roster, then whoever submitted earliest.
 */
export const RANKED_BOARD_SQL = `
select id, name, wins, losses, undefeated, overall, lineup, created_at
from gridiron_runs
order by wins desc, overall desc, created_at asc, id asc
limit $1
`;

export const COUNT_RUNS_SQL = `select count(*)::int as total from gridiron_runs`;

export const INSERT_RUN_SQL = `
insert into gridiron_runs (name, wins, losses, undefeated, overall, lineup, player_key)
values ($1, $2, $3, $4, $5, $6::jsonb, $7)
returning id, created_at
`;

/**
 * One device's own seasons, with the rank each one holds on the whole board —
 * the profile's read. The window's ORDER BY is the board's own ordering
 * (see RANKED_BOARD_SQL), so the number printed on a profile is the number on
 * the leaderboard; the outer ORDER BY is newest-first, which is how a profile
 * reads. Rows with no key (written before the column existed) match nothing, on
 * purpose: an unattributable run belongs to no profile.
 */
export const RANKED_RUNS_BY_PLAYER_SQL = `
select t.id, t.name, t.wins, t.losses, t.undefeated, t.overall, t.lineup, t.created_at, t.rank
from (
  select id, name, wins, losses, undefeated, overall, lineup, created_at, player_key,
         row_number() over (order by wins desc, overall desc, created_at asc, id asc) as rank
  from gridiron_runs
) t
where t.player_key = $1
order by t.created_at desc, t.id desc
`;

/** Position of the row just inserted, on the same order as the board. */
export const RANK_OF_RUN_SQL = `
select t.rank
from (
  select id,
         row_number() over (
           order by wins desc, overall desc, created_at asc, id asc
         ) as rank
  from gridiron_runs
) t
where t.id = $1
`;

/** Statements that must exist before any read or write. Run in order. */
export const SCHEMA_STATEMENTS = [
  CREATE_TABLE_SQL,
  ALTER_ADD_OVERALL_SQL,
  ALTER_ADD_PLAYER_KEY_SQL,
  DROP_OLD_INDEX_SQL,
  CREATE_INDEX_SQL,
  CREATE_PLAYER_KEY_INDEX_SQL,
] as const;
