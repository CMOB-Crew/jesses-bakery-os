"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/", label: "Overview", icon: "M4 13h6V4H4zM14 20h6v-9h-6zM14 8h6V4h-6zM4 20h6v-4H4z" },
  { href: "/stores", label: "Stores", icon: "M3 21V9l9-6 9 6v12h-6v-7H9v7z" },
  { href: "/deliveries", label: "Deliveries", icon: "M3 7h11v9H3zM14 10h4l3 3v3h-7z" },
  { href: "/production", label: "Production", icon: "M4 20h16M6 20v-6M18 20v-6M4 14h16l-2-8H6z" },
];

export default function Sidebar() {
  const path = usePathname();
  const isOn = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  return (
    <aside className="side">
      <div className="logo"><span className="mk">✦</span>Jesse&apos;s Bakery</div>
      <nav className="nav">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className={isOn(n.href) ? "on" : ""}>
            <svg viewBox="0 0 24 24"><path d={n.icon} /></svg>{n.label}
          </Link>
        ))}
        <div className="grp">Intelligence</div>
        <Link href="/assistant" className={isOn("/assistant") ? "on" : ""}>
          <svg viewBox="0 0 24 24"><path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" /></svg>Assistant
        </Link>
        <Link href="/settings" className={isOn("/settings") ? "on" : ""}>
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M19.4 13a1.6 1.6 0 00.1-1l1.6-1.2-1.6-2.8-1.9.8a1.6 1.6 0 00-1.4-.8L15.5 5h-3.2l-.3 2.2a1.6 1.6 0 00-1.4.8l-1.9-.8-1.6 2.8L8.7 12a1.6 1.6 0 000 1.6l-1.6 1.2 1.6 2.8 1.9-.8a1.6 1.6 0 001.4.8l.3 2h3.2l.3-2.2a1.6 1.6 0 001.4-.8l1.9.8 1.6-2.8L19.4 13z" /></svg>Settings
        </Link>
      </nav>
      <div className="side-foot">
        <div className="avatar">S</div>
        <div className="who">Simona<small>Operations</small></div>
      </div>
    </aside>
  );
}
