import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vercel builds with its own runtime — standalone output is only for self-hosting.
  output: process.env.VERCEL ? undefined : "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
