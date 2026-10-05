import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import type { ReactNode } from "react";

import appCss from "~/styles/app.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Gridiron Immortals" },
      // Site-wide, not per-page: installed-to-home-screen and the phone's
      // address bar should look the same on the game and on both boards. (Kept
      // free of any route name a build might not have: the paid app-store build
      // has no checkout-return page, and this comment reaches its bundle.)
      { name: "theme-color", content: "#070c17" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-title", content: "Gridiron" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "icon", type: "image/svg+xml", href: "/icon.svg" },
      // Fully opaque PNG, exactly 180x180 — iOS composites transparency to
      // black, so a see-through icon would land as a black square.
      { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon-180.png" },
    ],
  }),
  notFoundComponent: () => <div>Page not found</div>,
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

/**
 * The game is entirely client-side, so once its assets are cached it plays with
 * no network at all. Registration is production-only (a service worker in front
 * of the dev server only ever confuses HMR) and never fatal: if it fails, the
 * game behaves exactly as it did before.
 */
function OfflineSupport() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      /* no offline play on this device; nothing else changes */
    });
  }, []);
  return null;
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
        {import.meta.env.PROD ? <OfflineSupport /> : null}
      </body>
    </html>
  );
}
