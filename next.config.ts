import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname),
  serverExternalPackages: ["firebase-admin", "pdf-parse", "mammoth"],
  experimental: {
    // Generation can take 20-40s. Verify your host's function timeout
    // before shipping; if it is lower, switch to the async status-polling
    // pattern described in docs/ARCHITECTURE.md.
  },
};

export default nextConfig;
