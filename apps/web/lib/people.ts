import "server-only";
import { q as sql } from "@/lib/db";

/* ---------------------------------------------------------------------------
 * Reading the staff list, and writing down what was done to it.
 *
 * Reads only. Everything that CHANGES an account goes through the Supabase
 * auth admin API on the service role key -- see app/people/people-actions.ts --
 * because creating a login and setting a password are not things SQL can do.
 *
 * The split matters: reads are bounded by row-level security (migration 105
 * added the manager read; admin already had one), and writes are bounded by
 * lib/people-rules.ts, because a service-role write bypasses every policy by
 * definition. Two different mechanisms for two different things, and the
 * comment in 105 says so out loud so nobody later assumes the policies are
 * what is holding.
 *
 * Every caller wraps these in withUser(), the same as lib/queries.ts.
 * --------------------------------------------------------------------------- */

export type Person = {
  id: string;
  email: string;
  full_name: string | null;
  role: string | null;
  is_active: boolean;
  created_at: string;
};

/**
 * Everyone, newest role first then by name, so the floor is together and the
 * office is together.
 *
 * Does NOT swallow its error into an empty list. Most of lib/queries.ts does,
 * because a dashboard tile with no number is better than a page that will not
 * render. This is the screen somebody opens at 4am because a driver cannot
 * sign in: an empty list would read as "that person does not exist", and the
 * next thing that happens is a second account being created for somebody who
 * already has one.
 */
export async function listPeople(): Promise<Person[]> {
  const rows = await sql<Person[]>`
    select id::text,
           email,
           full_name,
           role::text                as role,
           is_active,
           created_at::text          as created_at
      from public.users
     order by case role
                when 'admin'   then 1
                when 'manager' then 2
                when 'office'  then 3
                when 'driver'  then 4
                when 'packer'  then 5
                else 9
              end,
              coalesce(full_name, email)`;
  return rows;
}

/** One person, or null. Read fresh before acting -- never from the browser. */
export async function getPerson(id: string): Promise<Person | null> {
  const rows = await sql<Person[]>`
    select id::text, email, full_name, role::text as role, is_active,
           created_at::text as created_at
      from public.users
     where id = ${id}
     limit 1`;
  return rows[0] ?? null;
}

/**
 * The signed-in person, from public.users rather than from the token.
 *
 * public.jb_uid() and NOT auth.uid(). The application connects as jbo_app,
 * which has no USAGE on schema auth, so a direct call is `permission denied
 * for schema auth` -- which is what this screen did on the afternoon it
 * shipped. Every other read in this codebase goes through
 * current_app_role() or jb_is_admin() for the same reason; migration 106
 * added the missing wrapper for the id.
 */
export async function getMe(): Promise<Person | null> {
  const rows = await sql<Person[]>`
    select id::text, email, full_name, role::text as role, is_active,
           created_at::text as created_at
      from public.users
     where id = public.jb_uid()
     limit 1`;
  return rows[0] ?? null;
}

/**
 * How many admins can still sign in.
 *
 * is_active matters and is not decoration: jb_role() returns a role only for a
 * row that is still active, so an inactive admin is not an admin as far as
 * every policy in the database is concerned. Counting rows with role='admin'
 * and ignoring the flag would let the last real admin be switched off while
 * the count still said two.
 */
export async function countActiveAdmins(): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from public.users
     where role = 'admin' and is_active`;
  return Number(rows[0]?.n ?? 0);
}

/**
 * Every action user_admin_events will accept.
 *
 * THIS LIST AND THE CHECK CONSTRAINT IN THE MIGRATIONS ARE THE SAME LIST.
 * They were not, for about a minute on 15 September: migration 107 added
 * 'password_changed' to the database and this union was left behind, so the
 * build failed on the one line that used it. It failed loudly and before
 * anything shipped, which is the good version -- but two copies of one list
 * in two files is the same shape as the 512-word list that moved into
 * password-words.json for exactly this reason.
 *
 * A guard in the ship script parses both and fails if they differ.
 */
export type AdminAction =
  | "created"
  | "password_reset"
  | "password_changed"
  | "deactivated"
  | "reactivated"
  | "role_changed";

/**
 * Write down what was done.
 *
 * Through the USER's connection, deliberately, not the service client. The
 * insert policy on user_admin_events checks actor_id = auth.uid(), so a row
 * cannot be written in somebody else's name -- and that check only means
 * anything if the insert actually goes through row-level security. Writing the
 * audit row with the service key would let the app claim any author it liked,
 * which is not an audit trail, it is a log.
 *
 * NEVER takes a password. There is no parameter for one and there should never
 * be.
 */
export async function recordEvent(e: {
  actorEmail: string;
  actorRole: string;
  action: AdminAction;
  targetId: string | null;
  targetEmail: string;
  targetRole: string | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  await sql`
    insert into public.user_admin_events
           (actor_id, actor_email, actor_role, action, target_id, target_email, target_role, detail)
    values (public.jb_uid(), ${e.actorEmail}, ${e.actorRole}, ${e.action},
            ${e.targetId}, ${e.targetEmail}, ${e.targetRole},
            ${JSON.stringify(e.detail ?? {})}::jsonb)`;
}

/** The last fifty things anybody did, for the bottom of the screen. */
export type AdminEvent = {
  at: string;
  actor_email: string;
  action: string;
  target_email: string;
  detail: Record<string, unknown>;
};

export async function recentEvents(): Promise<AdminEvent[]> {
  const rows = await sql<AdminEvent[]>`
    select at::text as at, actor_email, action, target_email, detail
      from public.user_admin_events
     order by at desc
     limit 50`;
  return rows;
}

/**
 * Set your own display name.
 *
 * Through jb_set_my_name(), a SECURITY DEFINER function that writes exactly
 * one column on exactly the caller's own row -- see migration 108 for why it
 * is not a policy. The short version: row-level security grants a WHOLE ROW,
 * so a "update your own row" policy would also let anybody set their own
 * role.
 *
 * Returns what the database actually stored, which is the trimmed version,
 * so the screen shows the truth rather than what was typed.
 */
export async function setMyName(name: string): Promise<string> {
  const rows = await sql<{ jb_set_my_name: string }[]>`
    select public.jb_set_my_name(${name}) as jb_set_my_name`;
  return rows[0]?.jb_set_my_name ?? name;
}

/**
 * What has been done to YOUR account.
 *
 * Reads the same table the People screen writes to. Migration 108 added the
 * policy that makes this possible: a person sees rows where they are the
 * target and no others.
 *
 * Until this, user_admin_events had no reader at all, which makes an audit
 * trail a log file.
 */
export async function myEvents(): Promise<AdminEvent[]> {
  const rows = await sql<AdminEvent[]>`
    select at::text as at, actor_email, action, target_email, detail
      from public.user_admin_events
     where target_id = public.jb_uid()
     order by at desc
     limit 20`;
  return rows;
}

