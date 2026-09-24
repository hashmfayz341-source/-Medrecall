/**
 * Checks that a route's trace manifest ships the pdfjs worker MODULE.
 *
 * Kept free of side effects so the unit tests can drive it with synthetic
 * manifests; scripts/verify-pdf-trace.mjs is the CLI that runs it after build.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

/** The exact file pdfjs imports. Not the source map, not a prefix match. */
export const WORKER_FILE = "pdf.worker.mjs";

/** Every App Route that parses a PDF, relative to .next/server/app. */
export const PDF_ROUTES = ["api/ingest", "api/ingest/selftest"];

/**
 * @param {string} manifestPath absolute path to a route.js.nft.json
 * @returns {{ ok: boolean, reason: string, workerPath?: string }}
 */
export function checkRouteManifest(manifestPath) {
  if (!existsSync(manifestPath)) {
    return { ok: false, reason: `no trace manifest at ${manifestPath}` };
  }

  let files;
  try {
    ({ files = [] } = JSON.parse(readFileSync(manifestPath, "utf8")));
  } catch {
    return { ok: false, reason: `unreadable trace manifest at ${manifestPath}` };
  }
  if (!Array.isArray(files)) {
    return { ok: false, reason: "trace manifest has no files array" };
  }

  // Exact basename match: "pdf.worker.mjs.map" must NOT satisfy this.
  const entries = files.filter(
    (entry) => typeof entry === "string" && basename(entry) === WORKER_FILE,
  );
  if (entries.length === 0) {
    const onlyMap = files.some(
      (entry) => typeof entry === "string" && basename(entry) === `${WORKER_FILE}.map`,
    );
    return {
      ok: false,
      reason: onlyMap
        ? `${WORKER_FILE} is NOT traced — only its source map is. The route would deploy without the worker.`
        : `${WORKER_FILE} is NOT traced. The route would deploy without the worker.`,
    };
  }

  // The manifest lists paths relative to itself; the file must really exist.
  const base = dirname(manifestPath);
  const present = entries
    .map((entry) => resolve(base, entry))
    .find((absolute) => existsSync(absolute));
  if (!present) {
    return {
      ok: false,
      reason: `${WORKER_FILE} is listed in the trace but does not exist on disk.`,
    };
  }

  return { ok: true, reason: "worker traced and present", workerPath: present };
}

/**
 * @param {string} projectRoot
 * @returns {{ route: string, ok: boolean, reason: string }[]}
 */
export function checkAllPdfRoutes(projectRoot) {
  return PDF_ROUTES.map((route) => {
    const manifest = resolve(projectRoot, ".next/server/app", route, "route.js.nft.json");
    return { route, ...checkRouteManifest(manifest) };
  });
}
