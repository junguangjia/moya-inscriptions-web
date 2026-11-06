import { withPayload } from "@payloadcms/next/withPayload";
import type { NextConfig } from "next";
// Development only: the same LAN/loopback hosts Web allows for device QA.
// Without 127.0.0.1 here, Next refuses its own dev chunks for that host and
// the Admin renders blank.
const allowedDevOrigins =
  process.env.NODE_ENV === "development"
    ? [
        "127.0.0.1",
        "localhost",
        ...(process.env.MOYA_ALLOWED_DEV_ORIGINS ?? "")
          .split(",")
          .map((origin) => origin.trim())
          .filter((origin) => origin.length > 0),
      ]
    : [];

/**
 * A Development-only, harness-owned build directory.
 *
 * `next dev` takes a lock under its dist directory and refuses to start a
 * second server for the same project — which is correct, and which also means
 * an acceptance harness cannot run while somebody's ordinary `pnpm dev:admin`
 * is up. Rather than stop a server this task does not own, the harness points
 * its own run at its own directory. Absent the variable nothing changes, and
 * it is ignored outside development so no build artifact can move in
 * Production.
 */
const harnessDistDir =
  process.env.NODE_ENV === "development" &&
  /^\.?[a-z][a-z0-9._-]{0,63}$/u.test(process.env.MOYA_ADMIN_DIST_DIR ?? "")
    ? process.env.MOYA_ADMIN_DIST_DIR
    : undefined;

/**
 * The login door's pages refuse to be framed, from the app itself, so Development,
 * the harness and Production answer alike. A hidden 允许 or 确认断开 in a frame
 * would otherwise rest on the session cookie's SameSite alone. `withPayload` adds
 * its own headers after these and keeps them. A browser applies these only when a
 * document loads, so a framed page elsewhere in /admin could still reach the AI
 * connections page through a tab change; the Production Nginx closes that for all
 * of /admin (record section 22, O4).
 */
const NO_FRAMES = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
];

const nextConfig: NextConfig = {
  agentRules: false,
  poweredByHeader: false,
  ...(harnessDistDir ? { distDir: harnessDistDir } : {}),
  ...(allowedDevOrigins.length > 0 ? { allowedDevOrigins } : {}),
  headers: async () => [
    { source: "/admin/agent-connections/:path*", headers: NO_FRAMES },
    { source: "/agent-connections/:path*", headers: NO_FRAMES },
  ],
  // One ingress hostname keeps host-only preview cookies; assets need a distinct prefix.
  assetPrefix: process.env.NODE_ENV === "production" ? "/admin-assets" : "",
  output: "standalone",
  // Next can externalize the native package only when Admin can resolve it.
  // Admin pins the already-used workspace version; native loading stays in Node.
  serverExternalPackages: ["opencc"],
  // OpenCC resolves its optional platform package dynamically at runtime.
  outputFileTracingIncludes: {
    "/*": [
      "../../node_modules/.pnpm/opencc@*/node_modules/@opencc/opencc-*/index.js",
      "../../node_modules/.pnpm/opencc@*/node_modules/@opencc/opencc-*/package.json",
      "../../node_modules/.pnpm/opencc@*/node_modules/@opencc/opencc-*/prebuilds/**/*.node",
    ],
  },
};
export default withPayload(nextConfig);
