/**
 * The two blocks /privacy and /support are built from: a titled card and a
 * bullet list. Plain, readable, and mobile-first — a card is one full-width
 * panel at 390px, and `break-words` keeps a long email address inside it.
 */
import type { ReactNode } from "react";

export function LegalCard({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      className="rounded-2xl border border-white/10 bg-[#0d1730] p-5"
    >
      <h2 className="text-base font-black leading-tight text-slate-100">{title}</h2>
      <div className="mt-2 space-y-2 text-sm leading-relaxed text-slate-300">{children}</div>
    </section>
  );
}

export function Bullets({ items, strong = false }: { items: ReactNode[]; strong?: boolean }) {
  return (
    <ul className="space-y-2">
      {items.map((item, index) => (
        <li key={index} className="flex gap-2">
          <span aria-hidden className={strong ? "text-[#f5c451]" : "text-slate-500"}>
            •
          </span>
          <span className="min-w-0 flex-1 break-words">{item}</span>
        </li>
      ))}
    </ul>
  );
}
