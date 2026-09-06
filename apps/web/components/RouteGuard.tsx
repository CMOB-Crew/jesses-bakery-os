"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { canOpen, homeFor } from "@/lib/nav-access";

/* ---------------------------------------------------------------------------
 * Sends a driver or a packer back to their own screen if they land somewhere
 * else -- a bookmark, a typed URL, a link somebody sent them.
 *
 * THIS IS NOT A SECURITY CONTROL, and it would be dangerous to think of it as
 * one. It runs in the browser. Anyone who wants to get past it can. The actual
 * boundary is row-level security, which returns zero rows to a driver on every
 * business table, and that boundary does not depend on this file existing.
 *
 * What this is for: a driver who follows an old bookmark to /stores after the
 * flip would otherwise get a store list with no stores in it. Not an error, not
 * a refusal -- an empty page that reads as a broken app. Every RLS failure in
 * this build has looked exactly like that, and it is the single hardest thing
 * to diagnose from a van at 4am. Sending them to the screen they actually want
 * costs nothing and removes the whole class of confusion.
 *
 * replace() rather than push(), so the back button does not bounce them
 * straight into the same wall.
 * --------------------------------------------------------------------------- */
export default function RouteGuard({ role }: { role: string | null }) {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (canOpen(role, pathname)) return;
    const home = homeFor(role);
    if (home && home !== pathname) router.replace(home);
  }, [role, pathname, router]);

  return null;
}
