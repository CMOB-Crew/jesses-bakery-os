"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Server Actions for the login form. Cookies set by the Supabase client during
// sign-in persist because Server Actions run where response headers can be set.
// All inert until Supabase Auth is configured (env vars present + provider on).

function safeNext(next: string | undefined | null): string {
  return next && next.startsWith("/") ? next : "/";
}

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
