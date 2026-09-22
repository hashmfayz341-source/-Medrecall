/**
 * Fails the build if any PDF-parsing route would ship without the pdfjs worker.
 *
 * This checks the PER-ROUTE trace manifests, which is what Vercel turns into
 * individual serverless functions. A standalone build cannot catch a per-route
 * gap: it merges every route's traced files into one shared node_modules tree,
 * so one route's include can mask another's omission.
 *
 *   node scripts/verify-pdf-trace.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Routes whose function must contain pdf.worker.mjs. */
const PDF_ROUTES = ["api/ingest", "api/ingest/selftest"];

let failed = false;

for (const route of PDF_ROUTES) {
  const manifest = resolve(root, ".next/server/app", route, "route.js.nft.json");
  if (!existsSync(manifest)) {
    console.error(`FAIL /${route}: no trace manifest at ${manifest}. Run "next build" first.`);
    failed = true;
    continue;
  }

  const { files = [] } = JSON.parse(readFileSync(manifest, "utf8"));
  const worker = files.filter((f) => f.includes("pdf.worker"));

  if (worker.length === 0) {
    console.error(
      `FAIL /${route}: pdf.worker.mjs is NOT traced. This route would deploy ` +
        `without the worker and every upload would fail with ` +
        `"Setting up fake worker failed".`,
    );
    failed = true;
  } else {
    console.log(`ok   /${route}: pdf.worker.mjs traced (${worker.length} entr${worker.length === 1 ? "y" : "ies"})`);
  }
}

if (failed) process.exit(1);
console.log("All PDF routes ship the worker.");
