"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import LinkPending from "./LinkPending";
import { canOpen, hasFullAccess } from "@/lib/nav-access";
import type { ReactNode } from "react";

const NAV: { href: string; label: string; icon: ReactNode }[] = [
  { href: "/", label: "Overview", icon: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></> },
  { href: "/stores", label: "Stores", icon: <path d="M3 10l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" /> },
  // Simona, 26 Aug: "Delivery run is probably a better terminology than region.
  // Delivery run will be, when map is, will be changed to delivery run and unify
  // it." Region is dropped as a word; the grouping and the run that services it
  // are one thing and now have one name.
  { href: "/map", label: "Delivery Runs", icon: <><path d="M9 3L3 6v15l6-3 6 3 6-3V3l-6 3-6-3z" /><path d="M9 3v15M15 6v15" /></> },
  { href: "/deliveries", label: "Deliveries", icon: <><rect x="1" y="6" width="15" height="11" rx="1" /><path d="M16 9h4l3 3v5h-7z" /><circle cx="6" cy="19" r="2" /><circle cx="19" cy="19" r="2" /></> },
  { href: "/production", label: "Production", icon: <path d="M3 21h18M4 21V9l5-3 5 3v12M14 21V11l6-3v13" /> },
  { href: "/products", label: "Products", icon: <><path d="M21 8l-9-5-9 5 9 5 9-5z" /><path d="M3 8v8l9 5 9-5V8M12 13v8" /></> },
  { href: "/lost-sales", label: "Lost sales", icon: <><path d="M3 17l6-6 4 4 7-8" /><path d="M21 12V7h-5" /></> },
  // Data in. Sits with the daily screens rather than under Setup, because a
  // dead feed is a today problem, not a configuration one.
  { href: "/feeds", label: "Sales feeds", icon: <><path d="M12 16V4" /><path d="M7 9l5-5 5 5" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></> },
];

// Jesse's own logo, not the loaf that stood in for it. One file,
// public/brand/jesses-bakery.png, used here, on all three sign-in screens, in
// the packing app header and on the printed packing slip -- so there is one
// place to change if the mark ever changes.
//
// alt="" and not a description: the words "Jesse's Bakery" sit right next to it
// in the markup, so a screen reader announcing the image as well would say it
// twice.
const EMBLEM = (
  // eslint-disable-next-line @next/next/no-img-element -- a 256px static mark rendered at 78px or smaller. next/image would put a build-time optimiser in front of the one screen nobody can work around if it fails, to save a few KB on an internal app
  <img className="emblem" src="/brand/jesses-bakery.png" alt="" width={256} height={256} />
);

// The footer chip used to be the literal string "Simona / Operations",
// hardcoded. With auth on it renders for every user — Tommy, Fred, a packer —
// and, because the nav sits outside the auth boundary, it renders on the
// sign-in page too, before anyone has logged in at all.
//
// It now shows whoever is actually signed in, and shows NOTHING when nobody is.
// The Sign out link is new: /auth/signout existed but nothing in the entire UI
// linked to it, so once auth went on there was no way for a user to sign out.
export type SidebarUser = { email?: string; role?: string };

// The application role, read server-side from public.users (see lib/app-role.ts).
// NOT SidebarUser.role -- that comes from the token and is always undefined,
// deliberately, per migration 012.

export default function Sidebar({ user = null, appRole = null }: { user?: SidebarUser | null; appRole?: string | null }) {
  const path = usePathname();
  const isOn = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  // A driver has one screen and a packer has one screen. Everyone else is
  // unchanged. See lib/nav-access.ts for why hiding these matters even though
  // RLS is what actually stops them reading anything.
  const full = hasFullAccess(appRole);
  const show = (href: string) => full || canOpen(appRole, href);
  return (
    <aside className="side">
      <div className="logo">{EMBLEM}<span className="logotext">Jesse&apos;s Bakery</span></div>
      <nav className="nav">
        {NAV.filter((n) => show(n.href)).map((n) => (
          <Link prefetch={false} key={n.href} href={n.href} className={isOn(n.href) ? "on" : ""}>
            <svg viewBox="0 0 24 24">{n.icon}</svg>{n.label}<LinkPending href={n.href} />
          </Link>
        ))}
        {full && <div className="grp">Setup</div>}
        {show("/new-store") && (
        <Link prefetch={false} href="/new-store" className={isOn("/new-store") ? "on" : ""}>
          <svg viewBox="0 0 24 24"><path d="M3 10l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" /><path d="M12 8v6M9 11h6" /></svg>New store<LinkPending href="/new-store" />
        </Link>
        )}
        {show("/new-run") && (
        <Link prefetch={false} href="/new-run" className={isOn("/new-run") ? "on" : ""}>
          <svg viewBox="0 0 24 24"><path d="M9 3L3 6v15l6-3 6 3 6-3V3l-6 3-6-3z" /><path d="M12 9v6M9 12h6" /></svg>New run<LinkPending href="/new-run" />
        </Link>
        )}
        {show("/new-product") && (
        <Link prefetch={false} href="/new-product" className={isOn("/new-product") ? "on" : ""}>
          <svg viewBox="0 0 24 24"><path d="M21 8l-9-5-9 5 9 5 9-5z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 14v5M9.5 16.5h5" /></svg>New product<LinkPending href="/new-product" />
        </Link>
        )}
        {show("/launches") && (
        <Link prefetch={false} href="/launches" className={isOn("/launches") ? "on" : ""}>
          <svg viewBox="0 0 24 24"><path d="M14 4c3 1 5 4 5 8l-3 3-4-4 3-3c-1 0-2 0-3 1M9 11l-4 1-1 4 3-1M12 15l1 4 4-1-1-4M6 15l-2 4 4-2" /></svg>Launches<LinkPending href="/launches" />
        </Link>
        )}
        {show("/archive") && (
        <Link prefetch={false} href="/archive" className={isOn("/archive") ? "on" : ""}>
          <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" /></svg>Archive<LinkPending href="/archive" />
        </Link>
        )}
        {full && <div className="grp">Intelligence</div>}
        {show("/assistant") && (
        <Link prefetch={false} href="/assistant" className={isOn("/assistant") ? "on" : ""}>
          <svg viewBox="0 0 24 24"><path d="M12 3l1.9 4.9L19 9l-4 3.4L16 18l-4-2.6L8 18l1-5.6L5 9l5.1-1.1z" /></svg>Assistant<LinkPending href="/assistant" />
        </Link>
        )}
        {show("/opportunities") && (
        <Link prefetch={false} href="/opportunities" className={isOn("/opportunities") ? "on" : ""}>
          <svg viewBox="0 0 24 24"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.3 1 2.5h6c0-1.2.2-1.7 1-2.5A6 6 0 0 0 12 3z" /></svg>Opportunities<LinkPending href="/opportunities" />
        </Link>
        )}
        {show("/seasonality") && (
        <Link prefetch={false} href="/seasonality" className={isOn("/seasonality") ? "on" : ""}>
          <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" /></svg>Seasonality<LinkPending href="/seasonality" />
        </Link>
        )}
        {show("/accuracy") && (
        <Link prefetch={false} href="/accuracy" className={isOn("/accuracy") ? "on" : ""}>
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="0.5" /></svg>Accuracy<LinkPending href="/accuracy" />
        </Link>
        )}
        {show("/benchmarks") && (
        <Link prefetch={false} href="/benchmarks" className={isOn("/benchmarks") ? "on" : ""}>
          <svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M20 20H3" /></svg>Benchmarks<LinkPending href="/benchmarks" />
        </Link>
        )}
        {show("/settings") && (
        <Link prefetch={false} href="/settings" className={isOn("/settings") ? "on" : ""}>
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" /></svg>Settings<LinkPending href="/settings" />
        </Link>
        )}
        {full && <div className="grp">Field</div>}
        {show("/driver") && (
        <Link prefetch={false} href="/driver" className={isOn("/driver") ? "on" : ""}>
          <svg viewBox="0 0 24 24"><rect x="1" y="6" width="15" height="11" rx="1" /><path d="M16 9h4l3 3v5h-7z" /><circle cx="6" cy="19" r="2" /><circle cx="19" cy="19" r="2" /></svg>Driver app <span style={{ marginLeft: "auto", fontSize: 9, fontWeight: 700, letterSpacing: ".5px", color: "var(--amber-t)", background: "var(--amber-b)", padding: "1px 5px", borderRadius: 999 }}>PROTO</span><LinkPending href="/driver" />
        </Link>
        )}
        {show("/packing") && (
        <Link prefetch={false} href="/packing" className={isOn("/packing") ? "on" : ""}>
          <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 4v16" /></svg>Packing app<LinkPending href="/packing" />
        </Link>
        )}
      </nav>
      {user && (
        <div className="side-foot">
          <div className="avatar">{(user.email ?? "?").trim().charAt(0).toUpperCase()}</div>
          <div className="who">
            {(user.email ?? "Signed in").split("@")[0]}
            {/* Only when we actually know. This said "no role set" to
                everyone, the admin included, because the role is not in the
                token -- and the sign-in page says an account with no role
                cannot see anything, so the two screens agreed with each
                other and both were wrong. */}
            {user.role && <small>{user.role}</small>}
          </div>
          <a className="signout" href="/auth/signout" title="Sign out">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h4a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-4" /><path d="M10 17l-5-5 5-5M5 12h12" /></svg>
            <span className="sr">Sign out</span>
          </a>
        </div>
      )}
      <style>{`
        .side .logo .emblem{width:34px;height:34px;flex:none;display:block;border-radius:50%;box-shadow:0 1px 3px rgba(60,45,30,.13)}
        .side .logo .logotext{font-family:var(--serif)}
        .side .side-foot .signout{margin-left:auto;display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:7px;color:var(--muted);flex:none}
        .side .side-foot .signout:hover{background:var(--line);color:var(--espresso)}
        .side .side-foot .signout svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
        .side .side-foot .signout .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
      `}</style>
    </aside>
  );
}
