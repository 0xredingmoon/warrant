/** @type {import('next').NextConfig} */
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");
export default {
  reactStrictMode: true,
  // STATIC_EXPORT=1 next build  ->  web/out/, plain files for any static host (settings come from /config.js)
  ...(process.env.STATIC_EXPORT === "1" ? { output: "export", images: { unoptimized: true } } : {}),
  // GitHub Pages project site is served at /warrant/; without basePath, /_next/* would 404 at the domain root.
  ...(basePath ? { basePath, assetPrefix: basePath, trailingSlash: true } : {}),
  transpilePackages: ["@warrant/sdk"],
  poweredByHeader: false,
};
