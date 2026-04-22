import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `next dev` cross-origin warning list. Prod builds ignore this entirely;
  // these just suppress dev-server origin warnings when hitting the app from
  // subdomains via `lvh.me` (local dev) or the real domain (staging-on-prod).
  allowedDevOrigins: [
    "lvh.me",
    "*.lvh.me",
    "bizfabric.ai",
    "*.bizfabric.ai",
  ],
};

export default nextConfig;
