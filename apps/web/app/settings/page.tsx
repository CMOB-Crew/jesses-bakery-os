import { getEngineProjection, getAppSettings, getFeedStatus } from "@/lib/queries";
import SettingsPanel from "@/components/SettingsPanel";

export const metadata = { title: "Settings · Jesse's Bakery OS" };
export const dynamic = "force-dynamic"; // render per request; keep off the flaky build-time prerender path

export default async function SettingsPage() {
  // Three round trips to Singapore is 3 x ~130ms of a 10s Netlify budget if
  // they queue up. Nothing here depends on anything else here.
  const [scenarios, settings, feeds] = await Promise.all([
    getEngineProjection(), getAppSettings(), getFeedStatus(),
  ]);
  return (
    <>
      <div className="head">
        <h1>Settings</h1>
        <div className="meta">How the plan sizes every order — every number is a lever</div>
      </div>
      <SettingsPanel scenarios={scenarios} settings={settings} feeds={feeds} />
    </>
  );
}
