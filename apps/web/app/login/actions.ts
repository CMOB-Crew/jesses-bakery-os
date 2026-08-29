"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { safeNext } from "@/lib/safe-next";

// Server Actions for the login form. Cookies set by the Supabase client during
// sign-in persist because Server Actions run where response headers can be set.
// All inert until Supabase Auth is configured (env vars present + provider on).

export async function signInWithPassword(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = safeNext(String(formData.get("next") ?? "/"));

  const supabase = await createSupabaseServerClient();
  if (!supabase) redirect("/login?error=Sign-in%20is%20not%20configured%20yet");

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    const q = new URLSearchParams({ error: error.message, next });
    redirect(`/login?${q.toString()}`);
  }
  redirect(next);
}

export async function signInWithMicrosoft(formData: FormData): Promise<void> {
  const next = safeNext(String(formData.get("next") ?? "/"));

  const supabase = await createSupabaseServerClient();
  if (!supabase) redirect("/login?error=Sign-in%20is%20not%20configured%20yet");

  const h = await headers();
  const origin = h.get("origin") ?? `https://${h.get("host") ?? ""}`;
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "azure", // Microsoft / Entra, per the stack decision record.
    options: {
      redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
      scopes: "email openid profile",
    },
  });
  if (error || !data?.url) redirect("/login?error=Could%20not%20start%20Microsoft%20sign-in");
  redirect(data.url);
}

// ---------------------------------------------------------------------
// Password reset.
//
// Until now there was no way back in: a locked-out user needed someone with
// Supabase dashboard access to reset them by hand. That is fine for one admin
// and untenable for a bakery going live to real staff on 3 Sept.
//
// The flow reuses the OAuth callback that already exists. Supabase sends a
// one-time code to /auth/callback, the route exchanges it for a session, and
// the user lands on /login/reset already authenticated -- so updateUser() has
// the session it needs. No new route, no token handling of our own.
// ---------------------------------------------------------------------

export async function requestPasswordReset(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim();

  const supabase = await createSupabaseServerClient();
  if (!supabase) redirect("/login?error=Sign-in%20is%20not%20configured%20yet");

  const h = await headers();
  const origin = h.get("origin") ?? `https://${h.get("host") ?? ""}`;

  // The result is deliberately ignored. Telling someone whether an address is
  // registered lets anyone enumerate who works here, so the page says the same
  // thing either way. A genuine failure still shows up in Supabase's own logs.
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/auth/callback?next=${encodeURIComponent("/login/reset")}`,
  });

  redirect("/login/forgot?sent=1");
}

export async function updatePassword(formData: FormData): Promise<void> {
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (password.length < 10) {
    redirect("/login/reset?error=" + encodeURIComponent("Password needs to be at least 10 characters."));
  }
  if (password !== confirm) {
    redirect("/login/reset?error=" + encodeURIComponent("Those two passwords do not match."));
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) redirect("/login?error=Sign-in%20is%20not%20configured%20yet");

  // Only works if the reset link established a session. If someone opens this
  // page cold there is nothing to update, and Supabase says so.
  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    redirect("/login/reset?error=" + encodeURIComponent(error.message));
  }
  redirect("/login?reset=1");
}
