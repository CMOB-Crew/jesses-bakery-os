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
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
