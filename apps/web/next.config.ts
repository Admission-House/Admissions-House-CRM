import type { NextConfig } from 'next';

// The browser talks to this app only; /api/v1 is passed on to the API, so the sign-in cookie is
// same-origin and the API needs no CORS for the web CRM.
const API_URL = process.env.API_URL ?? 'http://127.0.0.1:3001';

// Browser protections sent with every page. A full Content-Security-Policy is deliberately not set
// here: Next.js inlines scripts, so a safe policy needs a per-request nonce and a browser test.
// frame-ancestors is the part that stops clickjacking and is safe on its own.
const SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // geolocation is needed for the office check and the Detect button; nothing else is.
  { key: 'Permissions-Policy', value: 'geolocation=(self), camera=(), microphone=(), payment=(), usb=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  // Only takes effect over HTTPS, so it is harmless on a developer machine.
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
  env: { NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION ?? process.env.npm_package_version ?? '' },
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${API_URL}/api/v1/:path*` }];
  },
  turbopack: {
    rules: { '*.css': { loaders: ['@tailwindcss/turbopack'], as: '*.css' } },
  },
};

export default nextConfig;
