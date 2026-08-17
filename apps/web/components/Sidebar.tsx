"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const NAV: { href: string; label: string; icon: ReactNode }[] = [
  { href: "/", label: "Overview", icon: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></> },
  { href: "/stores", label: "Stores", icon: <path d="M3 10l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" /> },
  { href: "/map", label: "Map", icon: <><path d="M9 3L3 6v15l6-3 6 3 6-3V3l-6 3-6-3z" /><path d="M9 3v15M15 6v15" /></> },
  { href: "/deliveries", label: "Deliveries", icon: <><rect x="1" y="6" width="15" height="11" rx="1" /><path d="M16 9h4l3 3v5h-7z" /><circle cx="6" cy="19" r="2" /><circle cx="19" cy="19" r="2" /></> },
  { href: "/production", label: "Production", icon: <path d="M3 21h18M4 21V9l5-3 5 3v12M14 21V11l6-3v13" /> },
  { href: "/products", label: "Products", icon: <><path d="M21 8l-9-5-9 5 9 5 9-5z" /><path d="M3 8v8l9 5 9-5V8M12 13v8" /></> },
  { href: "/lost-sales", label: "Lost sales", icon: <><path d="M3 17l6-6 4 4 7-8" /><path d="M21 12V7h-5" /></> },
];

const EMBLEM = (
  <svg className="emblem" viewBox="0 0 40 40" aria-hidden="true">
    <defs><linearGradient id="jbLogo" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#c98a34" /><stop offset="1" stopColor="#9a6414" /></linearGradient></defs>
    <circle cx="20" cy="20" r="19" fill="url(#jbLogo)" />
    <path d="M10 25c0-6 4.5-9 10-9s10 3 10 9c0 2.2-1.6 3.4-3.4 3.4H13.4C11.6 28.4 10 27.2 10 25z" fill="#fbf0d8" />
    <path d="M16 21l-2 4.5M20 20l-2 5.5M24 21l-2 4.5" stroke="#b0741c" strokeWidth="1.5" strokeLinecap="round" fill="none" />
  </svg>
);

export default function Sidebar() {
  const path = usePathname();
  const isOn = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  return (
    <aside className="side">
      <div className="logo">{EMBLEM}<span className="logotext">Jesse&apos;s Bakery</span></div>
      <nav className="nav">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className={isOn(n.href) ? "on" : ""}>
            <svg viewBox="0 0 24 24">{n.icon}</svg>{n.label}
          </Link>
        ))}
        <div className="grp">Setup</div>
        <Link href="/new-store" className={isOn("/new-store") ? "on" : ""}>
          <svg viewBox="0 0 24 24"><path d="M3 10l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" /><path d="M12 8v6M9 11h6" /></svg>New store
        </Link>
        <Link href="/archive" className={isOn("/archive") ? "on" : ""}>
          <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" /></svg>Archive
        </Link>
        <div className="grp">Intelligence</div>
        <Link href="/assistant" className={isOn("/assistant") ? "on" : ""}>
          <svg viewBox="0 0 24 24"><path d="M12 3l1.9 4.9L19 9l-4 3.4L16 18l-4-2.6L8 18l1-5.6L5 9l5.1-1.1z" /></svg>Assistant
        </Link>
        <Link href="/opportunities" className={isOn("/opportunities") ? "on" : ""}>
          <svg viewBox="0 0 24 24"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.3 1 2.5h6c0-1.2.2-1.7 1-2.5A6 6 0 0 0 12 3z" /></svg>Opportunities
        </Link>
        <Link href="/seasonality" className={isOn("/seasonality") ? "on" : ""}>
          <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" /></svg>Seasonality
        </Link>
        <Link href="/accuracy" className={isOn("/accuracy") ? "on" : ""}>
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="0.5" /></svg>Accuracy
        </Link>
        <Link href="/benchmarks" className={isOn("/benchmarks") ? "on" : ""}>
          <svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M20 20H3" /></svg>Benchmarks
        </Link>
        <Link href="/settings" className={isOn("/settings") ? "on" : ""}>
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" /></svg>Settings
        </Link>
        <div className="grp">Field</div>
        <Link href="/driver" className={isOn("/driver") ? "on" : ""}>
          <svg viewBox="0 0 24 24"><rect x="1" y="6" width="15" height="11" rx="1" /><path d="M16 9h4l3 3v5h-7z" /><circle cx="6" cy="19" r="2" /><circle cx="19" cy="19" r="2" /></svg>Driver app
        </Link>
        <Link href="/packing" className={isOn("/packing") ? "on" : ""}>
          <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 4v16" /></svg>Packing app
        </Link>
      </nav>
      <div className="side-foot">
        <div className="avatar">S</div>
        <div className="who">Simona<small>Operations</small></div>
      </div>
      <style>{`
        .side .logo .emblem{width:27px;height:27px;flex:none;filter:drop-shadow(0 2px 4px rgba(120,80,20,.22))}
        .side .logo .logotext{font-family:var(--serif)}
      `}</style>
    </aside>
  );
}
