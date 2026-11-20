/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // STATIC_EXPORT=1 next build  ->  web/out/, plain files for any static host (settings come from /config.js)
  ...(process.env.STATIC_EXPORT === "1" ? { output: "export", images: { unoptimized: true } } : {}),
  transpilePackages: ["@warrant/sdk"],
  poweredByHeader: false,
};
