import type { Metadata } from "next";
import "./globals.css";
import Sidebar from "@/components/Sidebar";
import { getSessionClaims } from "@/lib/supabase/server";
import DemoTour from "@/components/DemoTour";

// Demo build only: the guided pop-up tour. NEXT_PUBLIC_DEMO is unset on the live
// site, so this is stripped/never mounts there.
const DEMO = process.env.NEXT_PUBLIC_DEMO === "1";

export const metadata: Metadata = {
  title: "Jesse's Bakery OS",
  description: "Waste, forecasting and distribution — Jesse's Bakery operating system.",
};

// Async so the sidebar can name whoever is actually signed in instead of
// asserting everyone is Simona. getSessionClaims is React-cached, so this is one
// verify per request, and it returns null on /login — where the chip then
// correctly renders nothing.
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionClaims().catch(() => null);
  return (
    <html lang="en-AU">
      <body>
        <div className="app">
          <Sidebar user={user} />
          <main className="main">{children}</main>
          {DEMO && <DemoTour />}
        </div>
      </body>
    </html>
  );
}
