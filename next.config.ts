import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /**
   * pdfjs resolves its worker with a runtime dynamic import. Bundling it
   * rewrites that path and the worker can no longer be found, so extraction
   * fails at runtime with "Setting up fake worker failed". Keeping the package
   * external leaves the import resolving from node_modules, which is how it
   * behaves under Node in the unit tests.
   */
  serverExternalPackages: ["pdfjs-dist"],
};

export default nextConfig;
