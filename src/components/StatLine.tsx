/**
 * The one way a player's average-season stat line reaches the screen.
 *
 * Takes the pool's `stats` object (or a drafted pick, via `pick`), drops every
 * "n/a" pair, and renders the rest as compact label/value pairs — e.g.
 * `PASS 4,102 · TD 32 · INT 11`. Deliberately secondary: small mono type, muted
 * labels, so the name and rating stay the loudest thing on the card. A record
 * with nothing displayable renders NOTHING (never a broken or empty label).
 *
 * Variants:
 *   "line"  — draft pool rows and the result screen's roster list (one line,
 *             truncates rather than overflowing on a narrow phone).
 *   "tight" — the starting-lineup tiles, which are ~4x smaller; the pairs may
 *             wrap between themselves but never inside a pair.
 */
import type { PlayerStats } from "~/data/players";
import { statPairs, statsFor } from "~/lib/statline";

export function StatLine({
  stats,
  pick,
  testId,
  className,
  variant = "line",
}: {
  /** Stats from a pool record. Ignored when `pick` is given. */
  stats?: PlayerStats | null;
  /** A drafted pick (name/team/decade), whose pool stats are looked up. */
  pick?: { name: string; team: string; decade: string } | undefined;
  testId: string;
  className?: string;
  variant?: "line" | "tight";
}) {
  const pairs = statPairs(stats ?? (pick ? statsFor(pick) : undefined));
  if (pairs.length === 0) return null;
  const pairClass = variant === "tight" ? "whitespace-nowrap" : undefined;
  return (
    <span
      data-testid={testId}
      data-stat-count={pairs.length}
      data-stat-variant={variant}
      className={[
        "block min-w-0 font-mono leading-tight",
        variant === "tight" ? "text-[9px]" : "text-[10px]",
        className ?? "",
      ]
        .join(" ")
        .trim()}
    >
      {pairs.map((pair, i) => (
        <span key={pair.key} data-stat={pair.key} className={pairClass}>
          {i > 0 ? (
            <span aria-hidden="true" className="text-slate-600">
              {" · "}
            </span>
          ) : null}
          <span className="text-slate-500">{pair.label}</span>{" "}
          <span className="text-slate-300">{pair.value}</span>
        </span>
      ))}
    </span>
  );
}
