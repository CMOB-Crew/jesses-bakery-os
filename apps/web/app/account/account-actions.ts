"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { withUser } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getMe, recordEvent, setMyName } from "@/lib/people";
import { checkNewPassword, checkName } from "@/lib/people-rules";
import { checkBeforeAttempt, recordOutcome } from "@/lib/login-rate-limit";
import { limiterStore, clientIp } from "@/lib/login-rate-limit-store";

/* ------------------------------------------------------------------ *
 * Changing your own password.
 *
 * The other half of the People screen. 105 let Simona hand somebody a
 * password; this lets that somebody stop using the one they were
 * handed. Until now nobody on this system could: every password was
 * chosen by another person, and /login/reset emails through Supabase's
 * shared sender -- two an hour, and driver and packer addresses have no
 * mailbox behind them at all.
 *
 * THE OLD PASSWORD IS REQUIRED, AND IT IS CHECKED BY SIGNING IN
 *
 * Not because the session is untrusted -- it is -- but because a signed
 * in session is a laptop somebody walked away from. Proving the old one
 * is what stops a password change being the easiest account takeover in
 * the building.
 *
 * AND THE ATTEMPT GOES THROUGH THE SAME LIMITER AS THE LOGIN PAGE
 *
 * Five a minute per identifier, checked BEFORE Supabase is asked, and
 * recorded either way. Without it this screen would be an unlimited
 * guessing window onto exactly the thing the login page rate limits --
 * and the floor passwords are BDriver<nn>!, a hundred possibilities on
 * a pattern every driver knows.
 *
 * THE NEW PASSWORD IS NEVER LOGGED, RETURNED OR STORED. The audit row
 * records that it changed and who changed it, which is all anybody can
 * ever need from it.
 * ------------------------------------------------------------------ */

export type ChangeResult = { ok: true; message: string } | { ok: false; error: string };

export async function changeMyPassword(input: {
  current: string;
  next: string;
  confirm: string;
}): Promise<ChangeResult> {
  let me;
  try {
    me = await withUser(getMe);
  } catch (e) {
    return {
      ok: false,
      error: `Could not work out who you are signed in as, so nothing has been changed. ` +
        `The database said: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!me) return { ok: false, error: "You do not appear to be signed in." };

  // A switched-off account changes nothing, and this one has to be checked
  // HERE rather than in the database: a password lives in Supabase Auth, not
  // in Postgres, and Supabase Auth has never heard of public.users.is_active.
  // Somebody switched off still authenticates -- that is measured, not assumed
  // -- so without this they could go on rotating the password of an account
  // that is supposed to be finished with.
  if (!me.is_active) {
    return {
      ok: false,
      error:
        "Your account is switched off, so it cannot be changed. Ask whoever " +
        "manages accounts to switch it back on.",
    };
  }

  // The rules first, so a typo never costs somebody one of their five
  // attempts a minute.
  const rules = checkNewPassword({
    next: input.next,
    confirm: input.confirm,
    current: input.current,
    email: me.email,
  });
  if (!rules.ok) return { ok: false, error: rules.reason };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, error: "Sign-in is not configured on this site." };

  const store = limiterStore();
  const ip = clientIp(await headers());
  const gate = await checkBeforeAttempt(store, me.email, "signin", ip);
  if (!gate.allowed) return { ok: false, error: gate.says };

  // Prove the old one. A failure here is a wrong password, counted the same
  // as a wrong password on the login page, because that is what it is.
  const { error: authErr } = await supabase.auth.signInWithPassword({
    email: me.email,
    password: input.current,
  });
  if (authErr) {
    await recordOutcome(store, me.email, "signin", "failed", ip);
    return {
      ok: false,
      error: "That is not the password you use now. Nothing has been changed.",
    };
  }
  await recordOutcome(store, me.email, "signin", "ok", ip);

  // Set the new one. Through the service client: a person cannot update their
  // own auth record from a normal session, and this is the same path the
  // People screen uses.
  const sb = supabaseAdmin();
  if (!sb) {
    return {
      ok: false,
      error: "Changing passwords is not switched on for this site — " +
        "SUPABASE_SERVICE_ROLE_KEY is not set. Nothing has been changed.",
    };
  }
  const { error } = await sb.auth.admin.updateUserById(me.id, { password: input.next });
  if (error) {
    return { ok: false, error: `The password was not changed: ${error.message}` };
  }

  try {
    await withUser(() =>
      recordEvent({
        actorEmail: me.email,
        actorRole: String(me.role ?? ""),
        action: "password_changed",
        targetId: me.id,
        targetEmail: me.email,
        targetRole: me.role,
      }),
    );
  } catch (e) {
    // The password HAS changed by this point. Refusing now would tell the
    // person it failed when it did not, and they would be locked out of an
    // account whose new password they were just told about. Logged instead.
    console.error(
      `[account] the audit row did not write for a self password change by ${me.email}`,
      e instanceof Error ? e.message : String(e),
    );
  }

  return {
    ok: true,
    message:
      "Password changed. It takes effect everywhere you are signed in, so use the " +
      "new one next time — including on your phone.",
  };
}

/**
 * Set your own name.
 *
 * NO AUDIT ROW, deliberately. user_admin_events records who could sign in and
 * who could not -- created, reset, switched off, re-roled. A person correcting
 * the spelling of their own surname is not that, and giving it an action name
 * would make the table harder to read for the thing it exists to answer.
 *
 * The change is not invisible: it lands on public.users, and it is the name
 * every delivery they sign from then on carries.
 */
export async function changeMyName(name: string): Promise<ChangeResult> {
  const rules = checkName(name);
  if (!rules.ok) return { ok: false, error: rules.reason };

  try {
    // Migration 109 refuses this at the database and THAT is the check that
    // counts -- this one is a courtesy, so the message arrives without a
    // round trip and both paths say the same sentence. It is deliberately not
    // the only guard: jb_set_my_name is SECURITY DEFINER, so no policy is
    // consulted on its update, and a guard that lives only in the app is a
    // guard that any other caller walks past.
    const me = await withUser(getMe);
    if (me && !me.is_active) {
      return {
        ok: false,
        error:
          "Your account is switched off, so it cannot be changed. Ask whoever " +
          "manages accounts to switch it back on.",
      };
    }
    const saved = await withUser(() => setMyName(name));
    // The root layout reads the name for the sidebar chip, so without this the
    // form says "Saved" while the corner of the screen still shows the old one
    // until a hard reload. "layout" rather than "page" because it is the
    // LAYOUT that reads it, and /account is only one of the pages under it.
    revalidatePath("/", "layout");
    return {
      ok: true,
      message:
        `Saved. Deliveries you sign from now on will say ${saved}. ` +
        `Ones you have already signed keep the name they were signed with.`,
    };
  } catch (e) {
    return {
      ok: false,
      error: `That did not save, and nothing has been changed. The database said: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
}

