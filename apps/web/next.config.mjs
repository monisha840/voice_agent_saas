/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Old URLs from before the Voice AI restructure keep working.
  async redirects() {
    return [
      { source: "/agent", destination: "/agents", permanent: false },
      { source: "/activity", destination: "/settings/activity", permanent: false },
    ];
  },
};

export default nextConfig;
