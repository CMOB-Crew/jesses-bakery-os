import type { Metadata } from "next";
import "./globals.css";
import Sidebar from "@/components/Sidebar";
import { getDisplayUser } from "@/lib/supabase/server";
import DemoTour from "@/components/DemoTour";

// Demo build only: the guided pop-up tour. NEXT_PUBLIC_DEMO is unset on the live
// site, so this is stripped/never mounts there.
const DEMO = process.env.NEXT_PUBLIC_DEMO === "1";

export const metadata: Metadata = {
  title: "Jesse's Bakery OS",
  description: "Waste, forecasting and distribution — Jesse's Bakery operating system.",
};

// Async so the sidebar can name whoever is actually signed in instead of
// asserting everyone is Simona.
//
// getDisplayUser, NOT getSessionClaims. The first shipped version of this used
// the verified read, which re-validates the token against the Supabase Auth
// server in Singapore. In the root layout that runs before every page on every
// route — a serial round trip in front of each page's own queries, and one on
// /login for a session that does not exist. Netlify allows a function 10
// seconds and it runs in us-east-1. Adding a Pacific crossing to the front of
// every cold start was my change and it was the wrong call.
//
// This reads the cookie locally. It gates nothing; it puts a name in a corner.
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getDisplayUser().catch(() => null);
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
