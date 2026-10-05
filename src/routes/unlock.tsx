/**
 * `/unlock` — where Stripe Checkout sends the payer back.
 *
 * Four states, and only one of them unlocks:
 *   1. already unlocked on this device  → say so, change nothing
 *   2. a checkout reference in the query → shape-check it, unlock, say so
 *   3. a query param that isn't one     → unlock NOTHING, say why
 *   4. no query param at all            → unlock NOTHING, point at the receipt
 *
 * The page never unlocks without a reference, never fakes a success, and never
 * calls the result a verified purchase: there is no server and no Stripe secret
 * behind this, so the reference is a claim we accept, not a payment we checked.
 * The copy says that plainly rather than implying otherwise.
 */
import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import SiteFooter from "~/components/SiteFooter";
import {
  checkoutRefFrom,
  grantUnlock,
  isCheckoutSessionId,
  isUnlocked,
  type Unlock,
} from "~/lib/entitlement";
import {
  BUY_LABEL,
  BUY_URL,
  PRICE_LABEL,
  PRODUCT_NAME,
  UNLOCK_ALREADY_BODY,
  UNLOCK_ALREADY_TITLE,
  UNLOCK_BACK,
  UNLOCK_BAD_PARAM_BODY,
  UNLOCK_BAD_PARAM_TITLE,
  UNLOCK_GRANTED_BODY,
  UNLOCK_GRANTED_CAVEAT,
  UNLOCK_GRANTED_TITLE,
  UNLOCK_NO_PARAM_BODY,
  UNLOCK_NO_PARAM_BUY,
  UNLOCK_NO_PARAM_TITLE,
  UNLOCK_PAGE_KICKER,
  UNLOCK_PAGE_TITLE,
} from "~/lib/paywall";

export const Route = createFileRoute("/unlock")({
  head: () => ({
    meta: [
      { title: "Unlock the full game — Gridiron Immortals" },
      {
        name: "description",
        content: `Where Stripe Checkout returns after buying ${PRODUCT_NAME} for ${PRICE_LABEL} — it turns the unlock on for the device that paid.`,
      },
      { name: "theme-color", content: "#070c17" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: UnlockPage,
});

type State =
  | { kind: "checking" }
  | { kind: "already" }
  | { kind: "granted"; unlock: Unlock }
  | { kind: "bad-param" }
  | { kind: "no-param" };

function UnlockPage() {
  const [state, setState] = useState<State>({ kind: "checking" });

  // Read after mount: the query string is only meaningful in the browser, and
  // the server-rendered markup has to match the first client pass.
  useEffect(() => {
    if (isUnlocked()) {
      setState({ kind: "already" });
      return;
    }
    const reference = checkoutRefFrom(window.location.search);
    if (reference === null) {
      setState({ kind: "no-param" });
      return;
    }
    if (!isCheckoutSessionId(reference)) {
      setState({ kind: "bad-param" });
      return;
    }
    setState({ kind: "granted", unlock: grantUnlock(reference) });
  }, []);

  return (
    <div className="min-h-dvh bg-[#070c17] text-slate-100">
      <div className="mx-auto w-full max-w-md px-4 pb-10 pt-5 lg:max-w-xl lg:px-8">
        <header className="mb-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-[#f5c451]">
            {UNLOCK_PAGE_KICKER}
          </p>
          <h1 className="text-xl font-black uppercase leading-none tracking-tight sm:text-2xl">
            {UNLOCK_PAGE_TITLE}
          </h1>
        </header>

        <div data-testid="unlock-page" className="space-y-4">
          {state.kind === "checking" ? (
            <section className="rounded-2xl border border-white/10 bg-[#0d1730] p-5">
              <p data-testid="unlock-checking" className="text-sm text-slate-400">
                Checking this device…
              </p>
            </section>
          ) : null}

          {state.kind === "granted" ? (
            <Card testId="unlock-granted" tone="good">
              <h2 className="text-lg font-black leading-tight">{UNLOCK_GRANTED_TITLE}</h2>
              <p className="mt-2 text-sm leading-relaxed text-slate-200">{UNLOCK_GRANTED_BODY}</p>
              <Caveat>{UNLOCK_GRANTED_CAVEAT}</Caveat>
            </Card>
          ) : null}

          {state.kind === "already" ? (
            <Card testId="unlock-already" tone="good">
              <h2 className="text-lg font-black leading-tight">{UNLOCK_ALREADY_TITLE}</h2>
              <p className="mt-2 text-sm leading-relaxed text-slate-200">{UNLOCK_ALREADY_BODY}</p>
            </Card>
          ) : null}

          {state.kind === "bad-param" ? (
            <Card testId="unlock-bad-param" tone="warn">
              <h2 className="text-lg font-black leading-tight">{UNLOCK_BAD_PARAM_TITLE}</h2>
              <p className="mt-2 text-sm leading-relaxed text-slate-200">
                {UNLOCK_BAD_PARAM_BODY}
              </p>
              <BuyLink />
            </Card>
          ) : null}

          {state.kind === "no-param" ? (
            <Card testId="unlock-no-param" tone="warn">
              <h2 className="text-lg font-black leading-tight">{UNLOCK_NO_PARAM_TITLE}</h2>
              <p className="mt-2 text-sm leading-relaxed text-slate-200">{UNLOCK_NO_PARAM_BODY}</p>
              <BuyLink label={UNLOCK_NO_PARAM_BUY} />
            </Card>
          ) : null}

          <Link
            to="/"
            data-testid="unlock-back"
            className="inline-block h-12 w-full rounded-2xl bg-[#f5c451] text-center text-sm font-black uppercase leading-[3rem] tracking-[0.18em] text-[#0a1020]"
          >
            {UNLOCK_BACK}
          </Link>
        </div>

        {/* A payer lands here from a receipt; support and the policy are one
            tap away whether the unlock worked or not. */}
        <SiteFooter />
      </div>
    </div>
  );
}

function Card({
  children,
  testId,
  tone,
}: {
  children: React.ReactNode;
  testId: string;
  tone: "good" | "warn";
}) {
  return (
    <section
      data-testid={testId}
      className={[
        "rounded-2xl border p-5",
        tone === "good"
          ? "border-[#f5c451]/60 bg-gradient-to-b from-[#3a2c07] to-[#0d1730]"
          : "border-white/15 bg-[#0d1730]",
      ].join(" ")}
    >
      {children}
    </section>
  );
}

function Caveat({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 border-t border-white/10 pt-3 text-[11px] leading-relaxed text-slate-400">
      {children}
    </p>
  );
}

function BuyLink({ label = BUY_LABEL }: { label?: string }) {
  return (
    <a
      href={BUY_URL}
      target="_blank"
      rel="noreferrer"
      data-testid="unlock-buy"
      className="mt-4 flex h-12 w-full items-center justify-center rounded-xl border border-[#f5c451]/60 text-center text-xs font-black uppercase leading-tight tracking-[0.14em] text-[#f8d98a]"
    >
      {label}
    </a>
  );
}
