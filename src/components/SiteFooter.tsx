/**
 * The site's footer: the two pages every player (and every store reviewer) has
 * to be able to reach — the privacy policy and support — plus the one honest
 * line about what the game is not.
 *
 * It goes on every public page: the game (where the money changes hands), the
 * two boards and /unlock (a stranger can land on any of them first, from a
 * shared link), and both legal pages themselves. `play` adds the way back into
 * the game for the pages that are not the game.
 *
 * The affiliation sentence is deliberately one line: it is a true statement
 * about real team and player names, not a legal essay.
 */
import { Link } from "@tanstack/react-router";

import { AFFILIATION_LINE } from "~/lib/legal";

const LINK_CLASS =
  "underline decoration-dotted decoration-white/30 underline-offset-4 transition hover:text-slate-200";

export default function SiteFooter({ play = false }: { play?: boolean }) {
  return (
    <footer className="mt-8 border-t border-white/10 pt-4 text-[11px] leading-relaxed text-slate-500">
      <nav
        data-testid="site-footer-links"
        aria-label="Site"
        className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 font-mono uppercase tracking-widest"
      >
        {play ? (
          <Link to="/" data-testid="footer-play" className={LINK_CLASS}>
            Play the game
          </Link>
        ) : null}
        <Link to="/privacy" data-testid="footer-privacy" className={LINK_CLASS}>
          Privacy
        </Link>
        <Link to="/support" data-testid="footer-support" className={LINK_CLASS}>
          Support
        </Link>
      </nav>
      <p data-testid="affiliation-line" className="mt-3 text-center">
        {AFFILIATION_LINE}
      </p>
    </footer>
  );
}
