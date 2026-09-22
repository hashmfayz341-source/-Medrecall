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
  /**
   * pdfjs loads its worker through a dynamic import built at runtime, which
   * static file tracing cannot see. The worker was therefore omitted from the
   * deployed function and every upload failed with "Setting up fake worker
   * failed: Cannot find module .../pdf.worker.mjs" — only in a traced bundle,
   * never under `next start`, where all of node_modules is on disk.
   *
   * Naming the file here forces it into the trace.
   */
  outputFileTracingIncludes: {
    "/api/ingest": [
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
    ],
  },
};

export default nextConfig;
