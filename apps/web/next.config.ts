import type { NextConfig } from 'next';

// The browser talks to this app only; /api/v1 is passed on to the API, so the sign-in cookie is
// same-origin and the API needs no CORS for the web CRM.
const API_URL = process.env.API_URL ?? 'http://127.0.0.1:3001';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  env: { NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION ?? process.env.npm_package_version ?? '' },
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${API_URL}/api/v1/:path*` }];
  },
  turbopack: {
    rules: { '*.css': { loaders: ['@tailwindcss/turbopack'], as: '*.css' } },
  },
};

export default nextConfig;
