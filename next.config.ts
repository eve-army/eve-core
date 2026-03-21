import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Avoid picking a parent folder lockfile (e.g. ~/package-lock.json) as the tracing root.
  outputFileTracingRoot: path.join(__dirname),
  eslint: {
    ignoreDuringBuilds: true,
  },
  async redirects() {
    return [
      {
        source: "/pumpfun",
        destination: "/eve",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
