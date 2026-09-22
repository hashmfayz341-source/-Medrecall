import { createRequire } from "node:module";

/**
 * `createRequire` behind a tiny wrapper.
 *
 * Kept separate so the unit tests can exercise `extractPdfPages` without the
 * ESM-only `import.meta.url` plumbing leaking into the extraction logic.
 */
export function createModuleRequire(url: string): NodeJS.Require {
  return createRequire(url);
}
