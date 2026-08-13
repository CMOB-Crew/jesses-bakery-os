"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const NAV: { href: string; label: string; icon: ReactNode }[] = [
  { href: "/", label: "Overview", icon: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></> },
  { href: "/stores", label: "Stores", icon: <path d="M3 10l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" /> },
  { href: "/deliveries", label: "Deliveries", icon: <><rect x="1" y="6" width="15" height="11" rx="1" /><path d="M16 9h4l3 3v5h-7z" /><circle cx="6" cy="19" r="2" /><circle cx="19" cy="19" r="2" /></> },
  { href: "/production", label: "Production", icon: <path d="M3 21h18M4 21V9l5-3 5 3v12M14 21V11l6-3v13" /> },
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
        <div className="grp">Intelligence</div>
        <Link href="/assistant" className={isOn("/assistant") ? "on" : ""}>
          <svg viewBox="0 0 24 24"><path d="M12 3l1.9 4.9L19 9l-4 3.4L16 18l-4-2.6L8 18l1-5.6L5 9l5.1-1.1z" /></svg>Assistant
        </Link>
        <Link href="/settings" className={isOn("/settings") ? "on" : ""}>
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" /></svg>Settings
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
