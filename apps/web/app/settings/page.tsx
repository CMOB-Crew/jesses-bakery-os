import { getEngineProjection, getAppSettings } from "@/lib/queries";
import SettingsPanel from "@/components/SettingsPanel";

export const metadata = { title: "Settings · Jesse's Bakery OS" };
export const dynamic = "force-dynamic"; // render per request; keep off the flaky build-time prerender path

export default async function SettingsPage() {
  const [scenarios, settings] = await Promise.all([getEngineProjection(), getAppSettings()]);
  return (
    <>
      <div className="head">
        <h1>Settings</h1>
        <div className="meta">How the plan sizes every order — every number is a lever</div>
      </div>
      <SettingsPanel scenarios={scenarios} settings={settings} />
    </>
  );
}
