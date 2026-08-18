import type { Metadata } from "next";
import "./globals.css";
import Sidebar from "@/components/Sidebar";
import DemoTour from "@/components/DemoTour";

// Demo build only: the guided pop-up tour. NEXT_PUBLIC_DEMO is unset on the live
// site, so this is stripped/never mounts there.
const DEMO = process.env.NEXT_PUBLIC_DEMO === "1";

export const metadata: Metadata = {
  title: "Jesse's Bakery OS",
  description: "Waste, forecasting and distribution — Jesse's Bakery operating system.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-AU">
      <body>
        <div className="app">
          <Sidebar />
          <main className="main">{children}</main>
          {DEMO && <DemoTour />}
        </div>
      </body>
    </html>
  );
}
