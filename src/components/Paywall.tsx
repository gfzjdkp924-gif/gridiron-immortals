/**
 * The paywall panel. Rendered *below* whatever the player is already looking at
 * — the finished result, or the home screen — never in place of it, and never
 * mid-run. It is the only place in the game that asks for money, and every word
 * it says comes from `~/lib/paywall`.
 */
import {
  BOARDS_FREE_NOTE,
  BUY_HINT,
  BUY_LABEL,
  BUY_URL,
  PAYWALL_KICKER,
  PAYWALL_LEAD,
  PAYWALL_TITLE,
  PRODUCT_NAME,
  UNLOCK_PERKS,
} from "~/lib/paywall";

export default function Paywall() {
  return (
    <section
      data-testid="paywall"
      className="mt-4 rounded-2xl border border-[#f5c451]/60 bg-gradient-to-b from-[#3a2c07] to-[#0d1730] p-5"
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-[#f5c451]">
        {PAYWALL_KICKER}
      </p>
      <h2 className="mt-1 text-xl font-black leading-tight">{PAYWALL_TITLE}</h2>
      <p className="mt-2 text-sm leading-relaxed text-slate-200">{PAYWALL_LEAD}</p>

      <ul className="mt-3 space-y-1">
        {UNLOCK_PERKS.map((perk) => (
          <li key={perk} className="flex items-start gap-2 text-xs text-slate-300">
            <span aria-hidden="true" className="mt-[3px] text-[#f5c451]">
              ✓
            </span>
            <span className="min-w-0 flex-1">{perk}</span>
          </li>
        ))}
      </ul>

      <a
        href={BUY_URL}
        target="_blank"
        rel="noreferrer"
        data-testid="paywall-buy"
        className="mt-4 flex h-14 w-full items-center justify-center rounded-2xl bg-[#f5c451] text-center text-base font-black uppercase leading-tight tracking-[0.14em] text-[#0a1020] transition active:scale-[0.98]"
      >
        {BUY_LABEL}
      </a>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-400">{BUY_HINT}</p>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{BOARDS_FREE_NOTE}</p>

      <p className="mt-3 border-t border-white/10 pt-3 text-[10px] leading-relaxed text-slate-500">
        {PRODUCT_NAME} · charged by Stripe
      </p>
    </section>
  );
}
