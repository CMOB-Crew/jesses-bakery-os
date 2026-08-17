import { getEngineProjection } from "@/lib/queries";
import SettingsPanel from "@/components/SettingsPanel";

export const metadata = { title: "Settings · Jesse's Bakery OS" };
export const dynamic = "force-dynamic"; // render per request; keep off the flaky build-time prerender path

export default async function SettingsPage() {
  const scenarios = await getEngineProjection();
  return (
    <>
      <div className="head">
        <h1>Settings</h1>
        <div className="meta">How the engine sizes every order — every number is a lever</div>
      </div>
      <SettingsPanel scenarios={scenarios} />
    </>
  );
}
