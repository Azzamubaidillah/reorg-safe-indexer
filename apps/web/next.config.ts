import type { NextConfig } from "next";

// Evaluated at build time: `next start` serves the routes manifest produced by `next build`, so API_URL must be set
// for the build, not only for the server process.
const apiUrl = process.env.API_URL ?? "http://127.0.0.1:3101";

const config: NextConfig = {
  // The browser only ever talks to this origin; the API is reached through the rewrite below.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/:path*` }];
  },
  // The contracts package ships TypeScript source.
  transpilePackages: ["@rsi/contracts"],
  poweredByHeader: false,
};

export default config;
