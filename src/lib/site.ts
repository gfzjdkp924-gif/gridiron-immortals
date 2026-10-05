/**
 * Gridiron Immortals — the one canonical address of the game.
 *
 * Used by the share card (a stranger reading a card in a group chat has to be
 * able to type the address) and by the Open Graph tags (a crawler needs an
 * absolute URL). Deliberately NOT `window.location`: the same build is also
 * served from a preview address, and a player's card must never send anyone
 * there.
 *
 * The canonical address is the owner's own domain (below), which the same
 * build also answers on alongside the platform's preview address — and the
 * app-store metadata, the growth material and the lawyer email all use it.
 * If the canonical address ever changes, these two lines are the only ones
 * that change: the card, the caption and the link preview read it from here.
 */
export const SITE_URL = "https://www.gridironimmortals.com";

/** The same address, as it is printed on the card and typed by a human. */
export const SITE_HOST = "www.gridironimmortals.com";

export const GAME_NAME = "Gridiron Immortals";

/** The one-line pitch, shared by the link preview and the card's footer. */
export const SITE_TAGLINE = "Spin a team + decade. Draft 11 legends. Chase 17–0.";
