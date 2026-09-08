import type { MetadataRoute } from "next";

/* ---------------------------------------------------------------------------
 * The web app manifest. This is what turns "Add to Home Screen" into an app
 * rather than a bookmark: an icon that is ours, a name under it, and a window
 * with no address bar and no bottom toolbar.
 *
 * The toolbar is not cosmetic here. It is what used to cover the Complete
 * button on the packing sheet, and the floor runs the whole bake off that
 * screen. An installed app has no browser chrome to get in the way.
 *
 * start_url is "/" and deliberately NOT "/packing". RouteGuard already sends a
 * driver to /driver and a packer to /packing, so one manifest puts every role
 * on the right screen without this file having to know about any of them --
 * and an admin who installs it still lands on the Overview.
 *
 * The colours are the design tokens from globals.css: --paper for the splash
 * ground, so a cold start does not flash white before the app paints.
 *
 * The 512 is listed twice, once "any" and once "maskable". Android crops a
 * maskable icon to whatever shape the launcher uses, and our mark sits inside
 * the central 80%, so the same file is safe for both. Listing only "maskable"
 * would make some launchers shrink it inside a second background.
 * ------------------------------------------------------------------------- */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Jesse's Bakery OS",
    short_name: "Jesse's Bakery",
    description:
      "Packing sheets, delivery runs and the daily plan for Jesse's Bakery.",
    start_url: "/",
    display: "standalone",
    background_color: "#f6f1e7",
    theme_color: "#f6f1e7",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
