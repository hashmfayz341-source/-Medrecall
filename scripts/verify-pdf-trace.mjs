/**
 * Fails the build if any PDF-parsing route would ship without the pdfjs worker.
 *
 * Runs automatically as part of `npm run build`, after `next build` has
 * written the per-route trace manifests. Those manifests are what Vercel turns
 * into individual serverless functions, so this is checked per route: a
 * standalone build cannot catch a per-route gap, because it merges every
 * route's traced files into one shared node_modules tree.
 *
 *   node scripts/verify-pdf-trace.mjs
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAllPdfRoutes } from "./pdf-trace-check.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const results = checkAllPdfRoutes(root);

for (const { route, ok, reason } of results) {
  console[ok ? "log" : "error"](`${ok ? "ok  " : "FAIL"} /${route}: ${reason}`);
}

if (results.some((r) => !r.ok)) {
  console.error(
    "\nPDF trace verification failed. Every upload to the listed route(s) would fail with " +
      '"Setting up fake worker failed". Check outputFileTracingIncludes in next.config.ts.',
  );
  process.exit(1);
}
console.log("All PDF routes ship the worker.");
