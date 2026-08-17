import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dashboard pages prerender against Supabase at build time. When the build
  // DB is briefly slow (pooler cold start / load), a heavy page like the Overview
  // can exceed Next's default 60s static-generation timeout and fail all 3
  // retries, which fails the whole deploy with exit code 2 -- the intermittent
  // "1 in 3" build flake. Giving prerender more headroom lets those pages finish
  // instead of the build dying. Readers are already guarded (a true outage
  // degrades to empty), so this only helps the slow-but-reachable case.
  staticPageGenerationTimeout: 180,
};

export default nextConfig;
