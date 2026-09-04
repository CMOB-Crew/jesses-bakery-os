"use client";

import { useEffect } from "react";
import { useLinkStatus } from "next/link";
import { setNavPending } from "./nav-pending";

// Rendered INSIDE a <Link>. useLinkStatus only reports for the link it sits
// under, which is why this is a child component rather than a hook called in
// Sidebar -- one Sidebar cannot ask "is any link pending", but twenty of these
// can each answer for themselves.
//
// Renders nothing. Its whole job is to report.
export default function LinkPending({ href }: { href: string }) {
  const { pending } = useLinkStatus();

  useEffect(() => {
    setNavPending(href, pending);
    // On unmount, release this link's claim. Without it, a nav item that
    // disappears mid-navigation (the sidebar re-rendering, a route group
    // swapping) would leave the store holding a navigation that nothing will
    // ever settle, and the skeleton would sit there forever.
    return () => setNavPending(href, false);
  }, [href, pending]);

  return null;
}
