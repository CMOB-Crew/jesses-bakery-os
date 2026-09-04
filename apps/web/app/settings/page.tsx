import { withUser } from "@/lib/db";
import { getEngineProjection, getAppSettings, getFeedStatus } from "@/lib/queries";
import SettingsPanel from "@/components/SettingsPanel";

export const metadata = { title: "Settings · Jesse's Bakery OS" };
export const dynamic = "force-dynamic";
// Netlify's platform maximum for a synchronous function is 60 seconds. No page
// here declared one, so every page ran on a default nobody chose — and the
// function log shows cold renders at 8.6, 10.0, 10.4 and 10.7 seconds with
// nothing above that, which is the shape of a ceiling around ten.
//
// This does not make the page fast. It stops a slow render being a broken one.
export const maxDuration = 60; // render per request; keep off the flaky build-time prerender path

export default async function SettingsPage() {
  // Three round trips to Singapore is 3 x ~130ms of a 10s Netlify budget if
  // they queue up. Nothing here depends on anything else here.
  const [scenarios, settings, feeds] = await withUser(() =>
    Promise.all([
    getEngineProjection(), getAppSettings(), getFeedStatus(),
  ])
  );
  return (
    <>
      <div className="head">
        <h1>Settings</h1>
        <div className="meta">How the plan sizes every order — each group says whether it reaches tonight&apos;s plan</div>
      </div>
      <SettingsPanel scenarios={scenarios} settings={settings} feeds={feeds} />
    </>
  );
}
