import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { safeNext } from "@/lib/safe-next";

// OAuth / magic-link return: exchange the one-time code for a session, then
// send the user on to where they were headed. Used by the Microsoft sign-in.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const nextParam = searchParams.get("next");
  // Already safe here -- the origin prefix below keeps any value on our own
  // domain -- but it uses the shared rule so there is only one to maintain.
  const next = safeNext(nextParam);

  if (code) {
    const supabase = await createSupabaseServerClient();
    if (supabase) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (!error) return NextResponse.redirect(`${origin}${next}`);
    }
  }
  return NextResponse.redirect(`${origin}/login?error=Sign-in%20link%20was%20invalid%20or%20expired`);
}
