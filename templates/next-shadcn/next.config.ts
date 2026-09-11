import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This folder is the project root, even if a stray lockfile sits in a folder above.
  turbopack: { root: process.cwd() },
};

export default nextConfig;
