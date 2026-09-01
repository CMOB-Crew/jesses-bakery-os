import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Service-role client. Bypasses row-level security by design, so it exists in
// exactly one file, is server-only, and is used for exactly two things: minting
// a one-time upload URL for a retailer report, and reading that object back.
//
// Returns null rather than throwing when the key is absent, so a deployment
// without it degrades to the ordinary multipart upload instead of erroring on
// every page that happens to import this.
export const FEED_BUCKET = "feed-uploads";

export function supabaseAdmin(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  // Three names, because the one I first used was never real. It came out of a
  // grep whose node_modules filter silently did nothing, so I built this around
  // a library's variable and the route answered 501 on a live deploy.
  //
  // SUPABASE_SERVICE_ROLE_KEY first: that is what Supabase's own dashboard
  // calls it, so it is what anyone pasting it will name it.
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
