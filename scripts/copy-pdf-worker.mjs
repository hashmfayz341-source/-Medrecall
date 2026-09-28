/**
 * Copies the pdfjs (legacy build) browser worker into public/ so page rendering in the
 * browser can load it from a plain URL. Bundler-emitted worker URLs proved
 * unreliable in the production build, so the worker is served as a static
 * file instead. Runs before `next dev` and `next build`; the copy is
 * git-ignored.
 *
 *   node scripts/copy-pdf-worker.mjs
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const worker = require.resolve("pdfjs-dist/legacy/build/pdf.worker.min.mjs");
mkdirSync(resolve(root, "public"), { recursive: true });
copyFileSync(worker, resolve(root, "public", "pdf.worker.min.mjs"));
console.log("pdf worker copied to public/pdf.worker.min.mjs");
