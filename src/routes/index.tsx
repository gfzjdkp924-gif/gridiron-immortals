import { createFileRoute } from "@tanstack/react-router";
import Game from "~/components/Game";
import { GAME_NAME, SITE_TAGLINE, SITE_URL } from "~/lib/site";

const TITLE = `${GAME_NAME} — spin a team + decade, chase 17–0`;
const DESCRIPTION =
  "Every pick starts with its own spin of a random NFL team and decade. Draft real legends from those eras into all 11 positions, then play the season to find out whether your all-time squad goes undefeated.";

/** 1200×630, the standard unfurl size, and a real file in public/. */
const OG_IMAGE = `${SITE_URL}/og-image.png`;

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      // Link previews. Absolute URLs and an explicit image size: a chat app
      // that has to fetch the image to size it often renders nothing instead.
      // og:url is the canonical address (see src/lib/site.ts), never whatever
      // host this build happens to be served from.
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: GAME_NAME },
      { property: "og:url", content: SITE_URL },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:image", content: OG_IMAGE },
      { property: "og:image:type", content: "image/png" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { property: "og:image:alt", content: `${GAME_NAME}. ${SITE_TAGLINE}` },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: TITLE },
      { name: "twitter:description", content: DESCRIPTION },
      { name: "twitter:image", content: OG_IMAGE },
      { name: "twitter:image:alt", content: `${GAME_NAME}. ${SITE_TAGLINE}` },
    ],
  }),
  component: Game,
});
