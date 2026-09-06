/* ---------------------------------------------------------------------------
 * Who is allowed to see which screens.
 *
 * WHY THIS EXISTS. Measured on the live site, 7 September, by signing in as a
 * real driver account for the first time: a driver sees the ENTIRE sidebar.
 * Overview, Stores, Production, Sales feeds, New store, Settings -- every screen
 * the business has -- and can open all of them.
 *
 * TWO DIFFERENT PROBLEMS, AND ONLY ONE OF THEM RLS SOLVES.
 *
 *   1. Data. After the RLS flip a driver opening Overview reads zero rows,
 *      because every policy compares current_app_role() against
 *      admin/manager/office. That part is handled, and it is the real security
 *      boundary. Nothing in this file is a security control and it must never
 *      be treated as one -- it runs in the browser and can be walked around.
 *
 *   2. What it LOOKS like. That is what this fixes. After the flip those pages
 *      do not refuse, they render EMPTY: a dashboard of zeros, a store list
 *      with no stores. To a driver at 4am that does not read as "not for me",
 *      it reads as "the app is broken", and the next thing that happens is a
 *      phone call to Simona during the morning run.
 *
 * So: don't show people doors that open onto empty rooms.
 *
 * THE FLOOR ROLES GET ONE SCREEN EACH. A driver has a phone in a van and one
 * job on it. A packer has the sheet and one job on it. Neither has any reason
 * to open the Settings page, and a driver who wanders into New store during a
 * delivery run is a support call nobody needs.
 *
 * admin / manager / office are unchanged and see everything, which is what they
 * see today.
 * --------------------------------------------------------------------------- */

export type AppRole = "admin" | "manager" | "office" | "driver" | "packer";

/** Roles that see the whole app. Anything not listed here is restricted. */
const FULL_ACCESS = new Set<string>(["admin", "manager", "office"]);

/**
 * The only paths a restricted role may open. Prefixes, so /driver and anything
 * under it are covered.
 *
 * /auth is here on purpose -- signing OUT must never be blocked. A person who
 * cannot leave is a worse bug than a person who can see too much.
 */
const ALLOWED: Record<string, string[]> = {
  driver: ["/driver", "/auth", "/login"],
  packer: ["/packing", "/auth", "/login"],
};

/** Where a restricted role should land, and be sent back to. */
const HOME: Record<string, string> = {
  driver: "/driver",
  packer: "/packing",
};

/** Everything, for a role with no restriction. */
export function hasFullAccess(role: string | null | undefined): boolean {
  return FULL_ACCESS.has(String(role ?? ""));
}

/**
 * May this role open this path?
 *
 * A null role returns TRUE deliberately. A null role already reads zero rows
 * from every table (migration 012's default deny, measured 4 September), so it
 * is not a person who needs shepherding -- it is an account nobody has finished
 * setting up. Bouncing them somewhere would hide that, and the thing they most
 * need is to SEE that the app is empty so somebody fixes their role.
 */
export function canOpen(role: string | null | undefined, pathname: string): boolean {
  const r = String(role ?? "");
  if (!(r in ALLOWED)) return true;
  return ALLOWED[r].some((p) => pathname === p || pathname.startsWith(p + "/"));
}

/** Where to send a restricted role that has landed somewhere it should not be. */
export function homeFor(role: string | null | undefined): string | null {
  return HOME[String(role ?? "")] ?? null;
}
