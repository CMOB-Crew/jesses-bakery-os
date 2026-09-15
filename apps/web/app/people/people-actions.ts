"use server";

import { revalidatePath } from "next/cache";
import { withUser } from "@/lib/db";
import { getAppRole } from "@/lib/app-role";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { makePassword } from "@/lib/passwords";
import {
  listPeople, getPerson, getMe, countActiveAdmins, recordEvent,
  type Person, type AdminAction,
} from "@/lib/people";
import {
  mayManagePeople, mayActOn, mayGrant, mayChangeOwnAccount,
  wouldRemoveLastAdmin, normaliseEmail,
} from "@/lib/people-rules";

/* ------------------------------------------------------------------ *
 * Creating an account, resetting a password, switching somebody off.
 *
 * WHY THESE EXIST. Until 15 September all three needed a terminal and
 * SUPABASE_SERVICE_ROLE_KEY, so all three were CMOB jobs, and the
 * Runbook said so: "Their password has to be reset and handed to them
 * directly. That is a CMOB job today." A system whose passwords only the
 * agency can reset has not been handed over.
 *
 * THE SHAPE OF EVERY ACTION IN THIS FILE, AND IT DOES NOT VARY
 *
 *   1. Read the actor's role from the DATABASE, never from the caller.
 *   2. Read the target FRESH from the database, never from the browser.
 *   3. Run the rules in lib/people-rules.ts.
 *   4. Only then touch anything.
 *   5. Write the audit row through the USER's connection, so auth.uid()
 *      is the author and cannot be claimed.
 *
 * Step 2 is the one that is easy to skip and expensive to skip. The
 * browser sends an id; everything else about that person -- their role,
 * whether they are the last admin -- is read here. A page that posted the
 * target's role along with the id would be handing the caller the thing
 * the decision turns on.
 *
 * WHY THE WRITES BYPASS ROW-LEVEL SECURITY, SAID OUT LOUD
 *
 * Creating a login and setting a password are Supabase auth admin calls
 * on the service role key. That key bypasses every policy in the
 * database, by design -- it is how the account gets made at all. So RLS
 * is NOT the control here and pretending otherwise would be the exact
 * failure db/RLS-AUDIT-2026-09-10.md spent a page on: a policy that looks
 * like the boundary while the real path goes around it.
 *
 * The control is this file plus lib/people-rules.ts, the rules are pure
 * and asserted in scripts/people-check.ts, and every action lands in
 * user_admin_events whether it succeeded or not mattered to anyone.
 *
 * A PASSWORD IS RETURNED ONCE AND NEVER WRITTEN DOWN. Not to the audit
 * table, not to a log, not into an error message. After the response is
 * rendered the system has no way to tell anyone what it was.
 * ------------------------------------------------------------------ */

export type PeopleResult =
  | { ok: true; message: string; email?: string; password?: string }
  | { ok: false; error: string };

const no = (error: string): PeopleResult => ({ ok: false, error });

/** Everything the screen needs, in one round trip. */
export async function loadPeople(): Promise<
  { ok: true; me: Person | null; people: Person[] } | { ok: false; error: string }
> {
  const role = await getAppRole();
  if (!mayManagePeople(role)) {
    return { ok: false, error: "Only an admin or a manager can see the staff list." };
  }
  try {
    const [me, people] = await withUser(async () => [await getMe(), await listPeople()] as const);
    return { ok: true, me, people };
  } catch (e) {
    // The reason, not just the fact. The first version of this said "Could not
    // read the staff list" and nothing else, and the actual cause -- permission
    // denied for schema auth -- took three wrong guesses and two scripts to
    // find. Only admins and managers reach this screen, so there is nobody to
    // keep it from.
    return {
      ok: false,
      error: `Could not read the staff list, and nothing has been changed. The database said: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
}

/**
 * The bit every action repeats: who am I, who are they, and may I.
 *
 * Returns the actor and the target, or a refusal. Reading both here keeps
 * the four actions below short enough to read in one go, which is the
 * property that makes a security check reviewable.
 */
async function gate(targetId: string): Promise<
  { ok: true; me: Person; target: Person; role: string } | { ok: false; error: string }
> {
  const role = await getAppRole();
  if (!mayManagePeople(role)) return { ok: false, error: "Only an admin or a manager can change accounts." };

  let me: Person | null;
  let target: Person | null;
  try {
    [me, target] = await withUser(async () => [await getMe(), await getPerson(targetId)] as const);
  } catch (e) {
    return {
      ok: false,
      error: `Could not read those accounts, so nothing has been changed. The database said: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
  if (!me) return { ok: false, error: "Could not work out who you are signed in as." };
  if (!target) return { ok: false, error: "That person is not in the staff list." };

  const allowed = mayActOn(role, target.role);
  if (!allowed.ok) return { ok: false, error: allowed.reason };

  return { ok: true, me, target, role: String(role) };
}

/** The service client, or a refusal that says what to do about it. */
function adminClient() {
  const sb = supabaseAdmin();
  if (!sb) {
    return no(
      "Account management is not switched on for this site — SUPABASE_SERVICE_ROLE_KEY " +
      "is not set. Nothing has been changed.",
    );
  }
  return sb;
}

async function audit(
  actor: Person, action: AdminAction, target: { id: string | null; email: string; role: string | null },
  detail?: Record<string, unknown>,
) {
  try {
    await withUser(() =>
      recordEvent({
        actorEmail: actor.email,
        actorRole: String(actor.role ?? ""),
        action,
        targetId: target.id,
        targetEmail: target.email,
        targetRole: target.role,
        detail,
      }),
    );
  } catch (e) {
    // Swallowed on purpose: an audit row that will not write must not undo an
    // account change that already happened -- that would leave the person
    // unable to sign in AND no record of why.
    //
    // But not silently. The one thing whose job is to notice everything must
    // not be able to stop working without anybody noticing, so it says so
    // where the deploy can be read.
    console.error(
      `[people] the audit row did not write: ${action} on ${target.email} by ${actor.email}`,
      e instanceof Error ? e.message : String(e),
    );
  }
}

/* ------------------------------------------------------------------ */

export async function createPerson(input: {
  email: string;
  fullName: string;
  role: string;
}): Promise<PeopleResult> {
  const actorRole = await getAppRole();
  if (!mayManagePeople(actorRole)) return no("Only an admin or a manager can create an account.");

  const email = normaliseEmail(input.email);
  if (!email.ok) return no(email.reason);

  const grant = mayGrant(actorRole, input.role);
  if (!grant.ok) return no(grant.reason);

  let me: Person | null;
  try {
    me = await withUser(getMe);
  } catch (e) {
    return no(
      `Could not work out who you are signed in as, so nothing has been changed. ` +
      `The database said: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!me) return no("Could not work out who you are signed in as.");

  const sb = adminClient();
  if ("ok" in sb) return sb;

  const password = makePassword(input.role);

  const { data, error } = await sb.auth.admin.createUser({
    email: email.email,
    password,
    email_confirm: true,
    user_metadata: { full_name: input.fullName.trim() || null },
  });
  if (error || !data?.user) {
    // Supabase says "User already registered" for a duplicate, which is the
    // common case and deserves the plain version of it.
    const msg = String(error?.message ?? "");
    if (/already/i.test(msg)) {
      return no(`${email.email} already has an account. Reset their password instead of making a second one.`);
    }
    return no(`The account was not created: ${msg || "Supabase gave no reason"}. Nothing has been changed.`);
  }

  // handle_new_user() has just made the public.users row with role NULL, which
  // is migration 012's deliberate default-deny. Give it the role it was asked
  // for. Through the service client, because a manager cannot write this table.
  const { error: roleErr } = await sb
    .from("users")
    .update({ role: input.role, full_name: input.fullName.trim() || null, is_active: true })
    .eq("id", data.user.id);

  if (roleErr) {
    await audit(me, "created", { id: data.user.id, email: email.email, role: null },
      { role_not_set: true, error: roleErr.message });
    return no(
      `The account was created but the ${input.role} role would not save, so they can sign in ` +
      `and will see nothing. Set the role before handing the password over.`,
    );
  }

  await audit(me, "created", { id: data.user.id, email: email.email, role: input.role });
  revalidatePath("/people");

  return {
    ok: true,
    message: `${email.email} can sign in now, as ${input.role}.`,
    email: email.email,
    password,
  };
}

export async function resetPassword(targetId: string): Promise<PeopleResult> {
  const g = await gate(targetId);
  if (!g.ok) return no(g.error);

  const sb = adminClient();
  if ("ok" in sb) return sb;

  const password = makePassword(g.target.role);
  const { error } = await sb.auth.admin.updateUserById(g.target.id, { password });
  if (error) return no(`The password was not changed: ${error.message}`);

  await audit(g.me, "password_reset", g.target);
  revalidatePath("/people");

  return {
    ok: true,
    message: `New password for ${g.target.email}. It is shown once — hand it over now.`,
    email: g.target.email,
    password,
  };
}

export async function setActive(targetId: string, active: boolean): Promise<PeopleResult> {
  const g = await gate(targetId);
  if (!g.ok) return no(g.error);

  if (!active) {
    const self = mayChangeOwnAccount(g.me.id, g.target.id, "deactivate");
    if (!self.ok) return no(self.reason);

    let admins = 0;
    try {
      admins = await withUser(countActiveAdmins);
    } catch (e) {
      return no(
        `Could not check how many admins are left, so nothing has been changed. ` +
        `The database said: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const last = wouldRemoveLastAdmin(g.target, admins, { deactivating: true });
    if (!last.ok) return no(last.reason);
  }

  const sb = adminClient();
  if ("ok" in sb) return sb;

  const { error } = await sb.from("users").update({ is_active: active }).eq("id", g.target.id);
  if (error) return no(`That did not save: ${error.message}`);

  await audit(g.me, active ? "reactivated" : "deactivated", g.target);
  revalidatePath("/people");

  return {
    ok: true,
    message: active
      ? `${g.target.email} can sign in again.`
      : `${g.target.email} is switched off. They can still sign in, and every screen will be empty, ` +
        `because the role only counts while the account is active.`,
  };
}

export async function setRole(targetId: string, newRole: string): Promise<PeopleResult> {
  const g = await gate(targetId);
  if (!g.ok) return no(g.error);

  const grant = mayGrant(g.role, newRole);
  if (!grant.ok) return no(grant.reason);

  const self = mayChangeOwnAccount(g.me.id, g.target.id, "role");
  if (!self.ok) return no(self.reason);

  let admins = 0;
  try {
    admins = await withUser(countActiveAdmins);
  } catch (e) {
    return no(
      `Could not check how many admins are left, so nothing has been changed. ` +
      `The database said: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const last = wouldRemoveLastAdmin(g.target, admins, { newRole });
  if (!last.ok) return no(last.reason);

  const sb = adminClient();
  if ("ok" in sb) return sb;

  const { error } = await sb.from("users").update({ role: newRole }).eq("id", g.target.id);
  if (error) return no(`That did not save: ${error.message}`);

  await audit(g.me, "role_changed", g.target, { from: g.target.role, to: newRole });
  revalidatePath("/people");

  return { ok: true, message: `${g.target.email} is now ${newRole}.` };
}
