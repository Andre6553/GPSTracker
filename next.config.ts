import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep eWeLink off the bundle; ensure traced files are copied into the serverless artifact on Vercel.
  serverExternalPackages: ["ewelink-api"],
  outputFileTracingIncludes: {
    "/api/gate-pulse": [
      "./node_modules/ewelink-api/**/*",
      "./node_modules/node-fetch/**/*",
      "./node_modules/crypto-js/**/*",
      "./node_modules/websocket/**/*",
      "./node_modules/websocket-as-promised/**/*",
      "./node_modules/delay/**/*",
      "./node_modules/random/**/*",
      "./node_modules/arpping/**/*",
    ],
  },
};

export default nextConfig;
