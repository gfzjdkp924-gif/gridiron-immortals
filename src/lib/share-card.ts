/**
 * Gridiron Immortals — the share card.
 *
 * After a season finishes, the player gets one action that produces a real
 * artifact: a 1080×1350 PNG (Instagram's 4:5 portrait, which also reads fine in
 * a group chat or as an X image) plus a short caption and the game's address.
 * Everything on it is read off the run the game actually played — the record,
 * the roster rating the game computed, the 11 drafted players by slot. Nothing
 * is invented and nothing is projected: a card exists only for a finished run.
 *
 * Two rules this module exists to keep:
 *
 *  - **Client-side only.** The image is drawn on a canvas in the browser, so
 *    sharing works with no server, no database and no network. The game's
 *    leaderboard being unreachable changes nothing here.
 *  - **Truthful labelling.** A run is 11 separate spins, one per pick, so the
 *    lineup usually spans several team-eras. The card's headline is therefore
 *    the MOST-DRAFTED team-era on the roster — the era that produced the most
 *    of the lineup, ties broken by the best player — and it says so in the
 *    label above it. There is no single "team they spun" to print, and we do
 *    not pretend otherwise.
 *
 * The picture is drawn at a fixed 1080×1350 regardless of the device: the
 * player's screen only ever sees a downscaled preview of it.
 */
import { ROSTER_SLOTS, type DraftedPlayer } from "~/lib/rating";
import { GAME_NAME, SITE_HOST, SITE_TAGLINE, SITE_URL } from "~/lib/site";
import type { StoredRun } from "~/lib/storage";

export const CARD_W = 1080;
export const CARD_H = 1350;

const GOLD = "#f5c451";
const WHITE = "#f8fafc";
const SLATE = "#94a3b8";
const NAVY = "#070c17";
const PANEL = "#13203d";
const INK = "#0a1020";

/**
 * The card travels without the rest of the site (someone posts the image on its
 * own), so it carries the same fact the site footer carries — see
 * AFFILIATION_LINE in src/lib/legal.ts. Shortened to one line that fits.
 */
const CARD_AFFILIATION = "Not affiliated with the NFL or any of its clubs.";

const FONT_SANS =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const FONT_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

const sans = (weight: number, px: number): string => `${String(weight)} ${String(px)}px ${FONT_SANS}`;
const mono = (weight: number, px: number): string => `${String(weight)} ${String(px)}px ${FONT_MONO}`;

/* ----------------------------------------------------------------- the model */

export interface SharePlayer {
  slot: string;
  name: string;
  /** "1990s Dallas Cowboys" — the team-era the game drafted him from. */
  era: string;
  /** The pool rating the game scored him with, as an integer. */
  rating: string;
}

export interface ShareCard {
  /** "1990s Dallas Cowboys" — the most-drafted team-era on the roster. */
  headline: string;
  /** The honest under-line: how many team-eras the lineup spans. */
  note: string;
  /** "14–3", en dash, exactly as the result screen prints it. */
  record: string;
  undefeated: boolean;
  ratingLabel: string;
  rating: string;
  players: SharePlayer[];
  caption: string;
  host: string;
  url: string;
  filename: string;
}

const eraOf = (player: { decade: string; team: string }): string => `${player.decade} ${player.team}`;

/** Slot order (QB, RB, WR1, …) so the card reads as a lineup, not a list. */
const slotOrder = (slot: string): number => {
  const index = ROSTER_SLOTS.findIndex((def) => def.slot === slot);
  return index === -1 ? ROSTER_SLOTS.length : index;
};

const slotIndexOf = (player: DraftedPlayer): number =>
  player.slot ? slotOrder(player.slot) : slotOrder(player.position);

export const buildShareCard = (run: StoredRun): ShareCard => {
  const players: SharePlayer[] = [...run.roster]
    .sort((a, b) => slotIndexOf(a) - slotIndexOf(b) || b.rating - a.rating)
    .map((player) => ({
      slot: player.slot || player.position,
      name: player.name,
      era: eraOf(player),
      rating: String(Math.round(player.rating)),
    }));

  // The most-drafted team-era: most picks wins; ties go to the era holding the
  // best player, then alphabetically, so the headline is stable for one run.
  const groups = new Map<string, { count: number; top: number }>();
  for (const player of run.roster) {
    const key = eraOf(player);
    const seen = groups.get(key) ?? { count: 0, top: Number.NEGATIVE_INFINITY };
    groups.set(key, { count: seen.count + 1, top: Math.max(seen.top, player.rating) });
  }
  const ranked = [...groups.entries()].sort(
    (a, b) => b[1].count - a[1].count || b[1].top - a[1].top || a[0].localeCompare(b[0]),
  );
  const headline = ranked[0]?.[0] ?? "";
  const eraCount = groups.size;
  const legends = run.roster.length;
  const legendWord = legends === 1 ? "legend" : "legends";

  const note =
    eraCount <= 1
      ? `All ${String(legends)} picks from this team-era`
      : `Lineup spans ${String(eraCount)} team-eras`;

  const record = `${String(run.wins)}–${String(run.losses)}`;
  const rating = run.overall.toFixed(1);

  const caption = run.undefeated
    ? `Undefeated: ${record}. ${String(legends)} ${legendWord} from ${String(eraCount)} team-eras, most-drafted era ${headline}, roster rating ${rating}. Can you match it? ${SITE_URL}`
    : `${record}. ${String(legends)} ${legendWord} from ${String(eraCount)} team-eras, most-drafted era ${headline}, roster rating ${rating}. Can you go 17–0? ${SITE_URL}`;

  return {
    headline,
    note,
    record,
    undefeated: run.undefeated,
    // The game's own word for it: the result screen prints "roster 94.2".
    ratingLabel: "Roster",
    rating,
    players,
    caption,
    host: SITE_HOST,
    url: SITE_URL,
    filename: `gridiron-immortals-${record.replace("–", "-")}${run.undefeated ? "-undefeated" : ""}.png`,
  };
};

/* --------------------------------------------------------------- canvas bits */

type Ctx = CanvasRenderingContext2D;

const roundRect = (ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void => {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, radius);
    return;
  }
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
};

/** Width of `text` with `spacing` px added between glyphs, at the live font. */
const trackedWidth = (ctx: Ctx, text: string, spacing: number): number => {
  const glyphs = [...text];
  return (
    glyphs.reduce((sum, ch) => sum + ctx.measureText(ch).width, 0) +
    spacing * Math.max(0, glyphs.length - 1)
  );
};

/** Monospace-ish tracked caps: canvas has no letter-spacing, so draw per glyph. */
const tracked = (
  ctx: Ctx,
  text: string,
  x: number,
  y: number,
  spacing: number,
  align: CanvasTextAlign = "left",
): number => {
  const glyphs = [...text];
  const widths = glyphs.map((ch) => ctx.measureText(ch).width);
  const total = trackedWidth(ctx, text, spacing);
  let cursor = align === "left" ? x : align === "right" ? x - total : x - total / 2;
  const previous = ctx.textAlign;
  ctx.textAlign = "left";
  for (let i = 0; i < glyphs.length; i += 1) {
    ctx.fillText(glyphs[i] ?? "", cursor, y);
    cursor += (widths[i] ?? 0) + spacing;
  }
  ctx.textAlign = previous;
  return total;
};

const ellipsize = (ctx: Ctx, text: string, maxWidth: number): string => {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
};

const wrap = (ctx: Ctx, text: string, maxWidth: number, maxLines: number): string[] => {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line.length === 0 ? word : `${line} ${word}`;
    if (ctx.measureText(next).width <= maxWidth) {
      line = next;
      continue;
    }
    if (line.length > 0) lines.push(line);
    line = word;
    if (lines.length === maxLines) break;
  }
  if (line.length > 0 && lines.length < maxLines) lines.push(line);
  const last = lines.length - 1;
  if (last >= 0) lines[last] = ellipsize(ctx, lines[last] ?? "", maxWidth);
  return lines;
};

const pill = (
  ctx: Ctx,
  text: string,
  x: number,
  y: number,
  height: number,
  spacing: number,
  fill: string,
  ink: string,
): number => {
  ctx.font = mono(700, 22);
  const width = trackedWidth(ctx, text, spacing) + 44;
  roundRect(ctx, x - width, y, width, height, height / 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.fillStyle = ink;
  tracked(ctx, text, x - width / 2, y + height / 2 + 8, spacing, "center");
  return width;
};

/* ------------------------------------------------------------------ the draw */

export const drawShareCard = (ctx: Ctx, card: ShareCard): void => {
  const PAD = 64;
  const width = CARD_W;
  const right = width - PAD;

  // Background: the site's navy, top-lit gold behind the record.
  const bg = ctx.createLinearGradient(0, 0, 0, CARD_H);
  bg.addColorStop(0, PANEL);
  bg.addColorStop(0.55, "#0b1428");
  bg.addColorStop(1, NAVY);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, CARD_H);

  const glow = ctx.createRadialGradient(width * 0.28, 520, 0, width * 0.28, 520, 620);
  glow.addColorStop(0, "rgba(245,196,81,0.16)");
  glow.addColorStop(1, "rgba(245,196,81,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, CARD_H);

  ctx.textBaseline = "alphabetic";

  /* ------------------------------------------------------------- brand line */
  ctx.font = sans(900, 46);
  ctx.fillStyle = WHITE;
  ctx.fillText("GRIDIRON", PAD, 108);
  const gridironWidth = ctx.measureText("GRIDIRON ").width;
  ctx.fillStyle = GOLD;
  ctx.fillText("IMMORTALS", PAD + gridironWidth, 108);

  ctx.font = mono(600, 20);
  ctx.fillStyle = SLATE;
  tracked(ctx, "All-time draft", right, 104, 4, "right");

  ctx.strokeStyle = "rgba(245,196,81,0.35)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PAD, 140);
  ctx.lineTo(right, 140);
  ctx.stroke();

  /* -------------------------------------------------------- team-era headline */
  ctx.font = mono(700, 22);
  ctx.fillStyle = GOLD;
  tracked(ctx, "Most-drafted team-era", PAD, 200, 5);

  ctx.font = sans(900, 66);
  ctx.fillStyle = WHITE;
  const headlineLines = wrap(ctx, card.headline, width - PAD * 2, 2);
  let cursor = 276;
  for (const line of headlineLines) {
    ctx.fillText(line, PAD, cursor);
    cursor += 78;
  }
  const noteBaseline = cursor - 78 + 48;

  ctx.font = mono(600, 22);
  ctx.fillStyle = SLATE;
  tracked(ctx, card.note, PAD, noteBaseline, 3);

  /* ------------------------------------------------------------------ record */
  const heroTop = noteBaseline + 34;
  const HERO_H = 190;
  const heroBaseline = heroTop + 150;

  ctx.font = mono(900, 150);
  ctx.fillStyle = card.undefeated ? GOLD : WHITE;
  ctx.fillText(card.record, PAD, heroBaseline);

  // Bottom-aligned so the rating chip sits in the same place either way, with
  // the undefeated badge stacked above it only when the season earned it.
  const chipW = 250;
  const chipH = 84;
  const chipY = heroTop + HERO_H - chipH - 6;
  if (card.undefeated) {
    pill(ctx, "UNDEFEATED", right, chipY - 66, 52, 5, GOLD, INK);
  }

  roundRect(ctx, right - chipW, chipY, chipW, chipH, 18);
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.14)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.font = mono(700, 18);
  ctx.fillStyle = SLATE;
  tracked(ctx, card.ratingLabel.toUpperCase(), right - chipW + 24, chipY + 34, 3);
  ctx.font = mono(900, 40);
  ctx.fillStyle = GOLD;
  ctx.textAlign = "right";
  ctx.fillText(card.rating, right - 24, chipY + 70);
  ctx.textAlign = "left";

  /* ------------------------------------------------------------ the 11 picks */
  const ROW_H = 58;
  const ROW_GAP = 6;
  const COL_GAP = 28;
  const COL_W = (width - PAD * 2 - COL_GAP) / 2;
  const ROWS = 6;
  const rowsTotal = ROWS * ROW_H + (ROWS - 1) * ROW_GAP;

  const footerH = 132;
  const footerTop = CARD_H - PAD - footerH;

  let rosterHeaderBaseline = heroTop + HERO_H + 46;
  let rowsTop = rosterHeaderBaseline + 22;
  // One-line headlines leave slack in the middle of the card; push the lineup
  // down towards the footer rather than leaving a hole above it.
  const slack = footerTop - 40 - (rowsTop + rowsTotal);
  if (slack > 0) {
    rosterHeaderBaseline += slack;
    rowsTop += slack;
  }

  ctx.font = mono(700, 22);
  ctx.fillStyle = SLATE;
  tracked(ctx, "Starting lineup", PAD, rosterHeaderBaseline, 5);
  ctx.font = mono(700, 20);
  ctx.fillStyle = GOLD;
  tracked(ctx, "Ovr", right, rosterHeaderBaseline, 5, "right");

  const drawRow = (player: SharePlayer, colX: number, rowY: number): void => {
    roundRect(ctx, colX, rowY, COL_W, ROW_H, 14);
    ctx.fillStyle = "rgba(255,255,255,0.04)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 2;
    ctx.stroke();

    const chipW2 = 56;
    roundRect(ctx, colX + 12, rowY + 14, chipW2, 30, 8);
    ctx.fillStyle = "rgba(245,196,81,0.16)";
    ctx.fill();
    ctx.font = mono(700, 18);
    ctx.fillStyle = GOLD;
    ctx.textAlign = "center";
    ctx.fillText(player.slot, colX + 12 + chipW2 / 2, rowY + 35);
    ctx.textAlign = "left";

    const textX = colX + 12 + chipW2 + 12;
    const ratingW = 48;
    const textW = COL_W - (textX - colX) - ratingW - 16;

    ctx.font = sans(700, 26);
    ctx.fillStyle = WHITE;
    ctx.fillText(ellipsize(ctx, player.name, textW), textX, rowY + 27);

    ctx.font = sans(400, 19);
    ctx.fillStyle = SLATE;
    ctx.fillText(ellipsize(ctx, player.era, textW), textX, rowY + 49);

    ctx.font = mono(700, 26);
    ctx.fillStyle = GOLD;
    ctx.textAlign = "right";
    ctx.fillText(player.rating, colX + COL_W - 16, rowY + 33);
    ctx.textAlign = "left";
  };

  const leftCount = Math.min(ROWS, card.players.length);
  for (let i = 0; i < leftCount; i += 1) {
    const player = card.players[i];
    if (player) drawRow(player, PAD, rowsTop + i * (ROW_H + ROW_GAP));
  }
  const rightPlayers = card.players.slice(ROWS);
  const rightOffset = ((ROWS - rightPlayers.length) * (ROW_H + ROW_GAP)) / 2;
  for (let i = 0; i < rightPlayers.length; i += 1) {
    const player = rightPlayers[i];
    if (player) {
      drawRow(player, PAD + COL_W + COL_GAP, rowsTop + rightOffset + i * (ROW_H + ROW_GAP));
    }
  }

  /* ------------------------------------------------------------------ footer */
  roundRect(ctx, PAD, footerTop, width - PAD * 2, footerH, 20);
  ctx.fillStyle = "rgba(245,196,81,0.10)";
  ctx.fill();
  ctx.strokeStyle = "rgba(245,196,81,0.32)";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.font = mono(700, 32);
  ctx.fillStyle = GOLD;
  tracked(ctx, card.host, PAD + 28, footerTop + 52, 3);

  ctx.font = sans(400, 23);
  ctx.fillStyle = "#cbd5e1";
  ctx.fillText(SITE_TAGLINE, PAD + 28, footerTop + 88);

  ctx.font = sans(400, 17);
  ctx.fillStyle = "rgba(148,163,184,0.85)";
  ctx.fillText(CARD_AFFILIATION, PAD + 28, footerTop + 116);
};

/** Draw the card and hand back a PNG. Browser-only by definition. */
export const renderShareCard = async (card: ShareCard): Promise<Blob> => {
  const canvas = document.createElement("canvas");
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  drawShareCard(ctx, card);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((result) => resolve(result), "image/png");
  });
  if (!blob) throw new Error("could not encode the card");
  return blob;
};

/* ------------------------------------------------- where the card goes next */

/**
 * Can this browser hand an image file to the OS share sheet? The probe file is
 * the documented test: `navigator.share` alone is not enough, because desktop
 * browsers and older mobile ones expose it without file support.
 */
export const canShareImage = (): boolean => {
  if (typeof navigator === "undefined" || typeof File === "undefined") return false;
  const nav = navigator as Navigator & { canShare?: (data?: ShareData) => boolean };
  if (typeof nav.share !== "function" || typeof nav.canShare !== "function") return false;
  try {
    return nav.canShare({ files: [new File([""], "probe.png", { type: "image/png" })] });
  } catch {
    return false;
  }
};

export const downloadBlob = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking immediately cancels the download on some browsers; the URL is
  // released on the next navigation at the latest, so a delay is the safe side.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
};

/** Clipboard write with the old textarea fallback for non-secure contexts. */
export const copyText = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the textarea path */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.left = "0";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
};

export type ShareOutcome = "shared" | "cancelled" | "downloaded" | "downloaded-no-caption";

const isAbort = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { name?: string }).name === "AbortError";

const newFile = (blob: Blob, filename: string): File =>
  new File([blob], filename, { type: "image/png" });

/**
 * The one action the result screen offers. Shares the PNG through the OS sheet
 * when the browser supports it; otherwise downloads the image and puts the
 * caption on the clipboard. Any failure of the share sheet itself (a target
 * that cannot take files, a browser that refuses mid-gesture) falls through to
 * the download path rather than leaving the player with nothing.
 */
export const shareCard = async (blob: Blob, card: ShareCard): Promise<ShareOutcome> => {
  if (canShareImage() && typeof navigator.share === "function") {
    try {
      await navigator.share({
        files: [newFile(blob, card.filename)],
        text: card.caption,
        title: `${GAME_NAME} — ${card.record}`,
      });
      return "shared";
    } catch (error) {
      if (isAbort(error)) return "cancelled";
    }
  }
  downloadBlob(blob, card.filename);
  const copied = await copyText(card.caption);
  return copied ? "downloaded" : "downloaded-no-caption";
};
