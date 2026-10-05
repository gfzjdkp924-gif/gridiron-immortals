/**
 * Gridiron Immortals — "Share my season", the one action a finished run offers.
 *
 * Behaviour, in the order it is decided:
 *
 *  1. The PNG is built by `renderShareCard()` as soon as the section mounts, not
 *     when the button is tapped. iOS only lets `navigator.share()` open while
 *     the tap that asked for it still counts as a user gesture, and awaiting the
 *     image first can spend that gesture — so the image is ready before the tap.
 *  2. If the browser can share image files (`canShareImage()`), the button says
 *     so and hands the file to the OS share sheet: Messages, Instagram, X.
 *  3. Otherwise the button says plainly that it downloads the image and copies
 *     the caption, and that is what it does — with the caption shown on screen
 *     for the browsers that refuse the clipboard too.
 *
 * This is deliberately NOT behind the paywall. The unlock buys repeat runs,
 * posting to the boards and the player rating (see src/lib/paywall.ts); sharing
 * your own result is free, and on a free player's device it is the only
 * advertisement the game has. `compact` renders the same action as a single
 * button, for the home screen's saved runs.
 */
import { SHARE_BADGE, SHARE_NOTE } from "~/lib/paywall";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildShareCard,
  canShareImage,
  copyText,
  renderShareCard,
  shareCard,
  type ShareOutcome,
} from "~/lib/share-card";
import type { StoredRun } from "~/lib/storage";

const STATUS_TEXT: Record<ShareOutcome, string> = {
  shared: "Your phone's share sheet opened with the card image.",
  cancelled: "Sharing cancelled — nothing was sent.",
  downloaded:
    "Card image saved to your downloads, and the caption below is on your clipboard. Paste it into your post.",
  "downloaded-no-caption":
    "Card image saved to your downloads. This browser blocked the clipboard, so copy the caption below yourself.",
};

type Mode = "share" | "download";

function useShareCard(run: StoredRun) {
  const card = useMemo(() => buildShareCard(run), [run]);
  const blobRef = useRef<Blob | null>(null);
  const urlRef = useRef<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ShareOutcome | null>(null);
  const [copied, setCopied] = useState(false);
  const [mode, setMode] = useState<Mode>("download");

  // Decided after mount so the server-rendered markup matches the first pass.
  useEffect(() => {
    setMode(canShareImage() ? "share" : "download");
  }, []);

  useEffect(() => {
    let live = true;
    blobRef.current = null;
    setPreview(null);
    setReady(false);
    setFailed(false);
    setOutcome(null);
    const timer = window.setTimeout(() => {
      void renderShareCard(card)
        .then((blob) => {
          if (!live) return;
          blobRef.current = blob;
          const url = URL.createObjectURL(blob);
          urlRef.current = url;
          setPreview(url);
          setReady(true);
        })
        .catch(() => {
          if (!live) return;
          setFailed(true);
          setReady(true);
        });
    }, 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, [card]);

  const start = useCallback(async (): Promise<void> => {
    setBusy(true);
    setOutcome(null);
    try {
      const blob = blobRef.current ?? (await renderShareCard(card));
      blobRef.current = blob;
      if (!urlRef.current) {
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        setPreview(url);
      }
      setFailed(false);
      setOutcome(await shareCard(blob, card));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [card]);

  const copyCaption = useCallback(async (): Promise<void> => {
    const ok = await copyText(card.caption);
    setCopied(ok);
  }, [card.caption]);

  const label = failed
    ? "Try the card again"
    : !ready
      ? "Preparing card…"
      : mode === "share"
        ? "Share my season"
        : "Download card + copy caption";

  return { card, mode, preview, ready, failed, busy, outcome, copied, label, start, copyCaption };
}

export function ShareResult({ run, compact = false }: { run: StoredRun; compact?: boolean }) {
  const share = useShareCard(run);
  const { card } = share;
  const showCaption = !compact || share.outcome === "downloaded-no-caption" || share.copied;

  return (
    <section
      data-testid="share-result"
      className="rounded-2xl border border-[#f5c451]/30 bg-[#0d1730] p-4"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.28em] text-[#f5c451]">
          Share your season
        </h3>
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-widest text-slate-500">
          {SHARE_BADGE}
        </span>
      </div>
      <p className="mt-2 text-sm text-slate-300">
        One image with your {String(card.players.length)} legends, the final record, the roster
        rating and where to play. {SHARE_NOTE}
      </p>
      <button
        type="button"
        onClick={() => void share.start()}
        disabled={share.busy || (!share.ready && !share.failed)}
        data-testid="share-button"
        data-mode={share.mode}
        className="mt-3 h-14 w-full rounded-2xl border border-[#f5c451] bg-[#f5c451] text-sm font-black uppercase tracking-[0.16em] text-[#0a1020] transition active:scale-[0.98] disabled:opacity-60"
      >
        {share.busy ? "Working…" : share.label}
      </button>
      <p className="mt-2 text-[11px] text-slate-400">
        {share.failed
          ? "This browser could not build the card. Your season is still saved on this device."
          : share.mode === "share"
            ? "Opens your phone's share sheet with the card image — Messages, Instagram, X, anywhere."
            : "Saves the card image and copies the caption, ready to paste into any app."}
      </p>

      {share.outcome ? (
        <p
          role="status"
          data-testid="share-status"
          className="mt-3 rounded-xl border border-[#f5c451]/40 bg-[#f5c451]/10 px-3 py-2 text-[11px] font-semibold text-[#f8d98a]"
        >
          {STATUS_TEXT[share.outcome]}
        </p>
      ) : null}

      {share.preview ? (
        <img
          data-testid="share-preview"
          src={share.preview}
          alt={`Season card: ${card.headline}, ${card.record}, roster rating ${card.rating}`}
          className={[
            "mx-auto mt-3 w-auto rounded-xl border border-white/10",
            compact ? "max-h-56" : "max-h-[70vh]",
          ].join(" ")}
        />
      ) : null}

      {showCaption ? (
        <div className="mt-3 border-t border-white/10 pt-3">
          <div className="flex items-baseline justify-between gap-3">
            <h4 className="font-mono text-[10px] uppercase tracking-[0.28em] text-slate-400">
              Caption
            </h4>
            <button
              type="button"
              onClick={() => void share.copyCaption()}
              data-testid="share-copy-caption"
              className="font-mono text-[10px] uppercase tracking-widest text-[#f5c451] underline decoration-dotted"
            >
              {share.copied ? "Copied" : "Copy caption"}
            </button>
          </div>
          <p data-testid="share-caption" className="mt-2 break-words text-[11px] leading-relaxed text-slate-400">
            {card.caption}
          </p>
        </div>
      ) : null}
    </section>
  );
}
