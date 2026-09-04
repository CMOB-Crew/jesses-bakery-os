"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import Skeleton from "./Skeleton";
import { subscribeNav, getNav, getNavServer, clearNav } from "./nav-pending";

// Wraps the page. While a sidebar navigation is in flight it shows the skeleton
// for where you are GOING instead of the page you are leaving.
//
// children is a server-rendered slot passed straight through, so nothing about
// the pages themselves changes and no page becomes a client component. See
// nav-pending.ts for why this is not loading.tsx.

type Variant = "dashboard" | "table" | "board" | "profile" | "cards" | "generic";

// Longest prefix wins, so /store/ gets the profile shape rather than falling in
// with the /stores table, and a path matching nothing lands on generic.
const SHAPES: [string, Variant][] = [
  ["/stores", "table"],
  ["/store/", "profile"],
  ["/products", "table"],
  ["/product/", "profile"],
  ["/region/", "profile"],
  ["/lost-sales", "table"],
  ["/launches", "table"],
  ["/archive", "table"],
  ["/opportunities", "table"],
  ["/map", "board"],
  ["/deliveries", "board"],
  ["/delivery-sheet", "board"],
  ["/production", "board"],
  ["/packing", "board"],
  ["/seasonality", "cards"],
  ["/accuracy", "dashboard"],
  ["/benchmarks", "dashboard"],
];

function shapeFor(href: string): Variant {
  if (href === "/") return "dashboard";
  let best: Variant = "generic";
  let bestLen = 0;
  for (const [prefix, variant] of SHAPES) {
    if (href.startsWith(prefix) && prefix.length > bestLen) {
      best = variant;
      bestLen = prefix.length;
    }
  }
  return best;
}

export default function RouteFrame({ children }: { children: ReactNode }) {
  const nav = useSyncExternalStore(subscribeNav, getNav, getNavServer);
  const pathname = usePathname();

  // The navigation landed. Clearing the store is an update to an external
  // system, not React state, so it belongs in an effect and causes no cascade.
  //
  // This is the belt to LinkPending's braces, and it is what guarantees that
  // arriving somewhere always ends the skeleton even if the link that started
  // it never reports settling.
  useEffect(() => {
    clearNav();
  }, [pathname]);

  if (nav?.visible) return <Skeleton variant={shapeFor(nav.href)} />;
  return <>{children}</>;
}
