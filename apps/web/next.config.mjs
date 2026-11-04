/** @type {import('next').NextConfig} */
const apiUrl = process.env.API_INTERNAL_URL ?? "http://localhost:4000";

const nextConfig = {
  // Standalone output is for the Docker image (it needs symlinks, which Windows may block locally).
  output: process.env.NEXT_STANDALONE === "1" ? "standalone" : undefined,
  reactStrictMode: true,
  // Same-origin proxy so the httpOnly session cookie works without third-party cookie issues.
  // Media never goes through here: uploads/downloads use signed storage URLs directly.
  async rewrites() {
    return [{ source: "/api/v1/:path*", destination: `${apiUrl}/api/v1/:path*` }];
  },
};

export default nextConfig;
