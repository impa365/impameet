/** @type {import('next').NextConfig} */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=()',
  },
];

const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  // No server-side image optimisation: keeps sharp/libvips out of the runtime image.
  images: { unoptimized: true },
  reactStrictMode: true,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
