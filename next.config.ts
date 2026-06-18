import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// Pin the workspace root to this project. A stray parent lockfile
// (C:\Users\Jordy\package-lock.json) otherwise makes Next infer the wrong root.
const projectRoot = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  turbopack: {
    root: projectRoot,
  },
  allowedDevOrigins: [
    "192.168.178.150",
    "10.0.0.18",
    // Accessing the dev server through `tailscale serve` makes the browser origin
    // the Tailscale domain, which Next blocks unless allowed — that breaks the
    // post-login RSC refresh. The exact tailnet host + a wildcard for other devices.
    "desktop-rop8tsg.tailb5e0d.ts.net",
    "*.ts.net",
    // Same story for the Cloudflare Tunnel public hostname: the browser origin
    // becomes app.dweemo.nl, which Next blocks unless allowed — breaking the
    // post-login RSC refresh. `*.dweemo.nl` does NOT match the bare apex, so the
    // apex is listed explicitly for when the tunnel routes dweemo.nl itself.
    "dweemo.nl",
    "app.dweemo.nl",
    "*.dweemo.nl",
  ],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "cards.scryfall.io",
      },
    ],
  },
  // Hide the on-screen Next.js dev tools button / route indicator.
  devIndicators: false,
};

export default nextConfig;
