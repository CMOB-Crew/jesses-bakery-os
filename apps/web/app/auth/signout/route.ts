import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Sign out and return to the login screen. POST-only so a link prefetch or a
// stray GET can't end a session. 303 so the browser follows with a GET.
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  if (supabase) await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
}
