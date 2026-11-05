import path from 'node:path';
import type { NextConfig } from 'next';

// Browser protections sent with every page. This site has no sign-in and loads nothing from other
// websites except its two fonts (fetched at build time and served from this site).
const SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Stops `next dev` from writing an AGENTS.md of instructions for AI tools into the project.
  agentRules: false,
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
  turbopack: {
    rules: { '*.css': { loaders: ['@tailwindcss/turbopack'], as: '*.css' } },
  },
};

export default nextConfig;
