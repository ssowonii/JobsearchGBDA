import type { NextConfig } from 'next';

// /api/* is served by FastAPI: locally by uvicorn on :8000 (`npm run dev`), on Vercel by the
// Python function in api/index.py (the rewrite target "/api/" is that function).
const nextConfig: NextConfig = {
  // crawl steps run ~90 s; the dev proxy to uvicorn would otherwise give up after 30 s
  experimental: { proxyTimeout: 300_000 },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: process.env.NODE_ENV === 'development' ? 'http://127.0.0.1:8000/api/:path*' : '/api/',
      },
    ];
  },
};

export default nextConfig;
