"use server";

import { headers } from "next/headers";
import { withUser } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getMe, recordEvent } from "@/lib/people";
import { checkNewPassword } from "@/lib/people-rules";
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
