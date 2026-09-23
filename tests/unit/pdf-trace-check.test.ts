import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PDF_ROUTES,
  WORKER_FILE,
  checkAllPdfRoutes,
  checkRouteManifest,
} from "../../scripts/pdf-trace-check.mjs";

/**
 * Synthetic trace manifests laid out like Next's, with the referenced files
 * actually created (or not) on disk.
 */
let dirs: string[] = [];

function fixture(entries: { path: string; create: boolean }[]) {
  const root = mkdtempSync(join(tmpdir(), "trace-"));
  dirs.push(root);
  const routeDir = join(root, ".next/server/app/api/ingest");
  mkdirSync(routeDir, { recursive: true });
  const buildDir = join(root, "node_modules/pdfjs-dist/legacy/build");
  mkdirSync(buildDir, { recursive: true });

  for (const entry of entries) {
    if (entry.create) writeFileSync(join(buildDir, entry.path), "// stub");
  }
  const manifest = join(routeDir, "route.js.nft.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      version: 1,
      files: entries.map(
        (e) => `../../../../../node_modules/pdfjs-dist/legacy/build/${e.path}`,
      ),
    }),
  );
  return { root, manifest };
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("the trace checker requires the exact worker module", () => {
  it("passes when pdf.worker.mjs is traced and present on disk", () => {
    const { manifest } = fixture([
      { path: "pdf.worker.mjs", create: true },
      { path: "pdf.worker.mjs.map", create: true },
    ]);
    const result = checkRouteManifest(manifest);
    expect(result.ok).toBe(true);
    expect(result.workerPath?.endsWith(WORKER_FILE)).toBe(true);
  });

  it("FAILS when only the source map is traced (the false-positive case)", () => {
    const { manifest } = fixture([{ path: "pdf.worker.mjs.map", create: true }]);
    const result = checkRouteManifest(manifest);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/only its source map/);
  });

  it("FAILS when the worker is listed but missing on disk", () => {
    const { manifest } = fixture([{ path: "pdf.worker.mjs", create: false }]);
    const result = checkRouteManifest(manifest);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not exist on disk/);
  });

  it("FAILS when no worker entry exists at all", () => {
    const { manifest } = fixture([{ path: "pdf.mjs", create: true }]);
    expect(checkRouteManifest(manifest).ok).toBe(false);
  });

  it("does not accept look-alike names", () => {
    for (const name of ["pdf.worker.mjs.map", "pdf.worker.min.mjs", "xpdf.worker.mjs"]) {
      const { manifest } = fixture([{ path: name, create: true }]);
      expect(checkRouteManifest(manifest).ok, name).toBe(false);
    }
  });

  it("FAILS when the manifest itself is missing or unreadable", () => {
    expect(checkRouteManifest("/nonexistent/route.js.nft.json").ok).toBe(false);
    const { manifest } = fixture([]);
    writeFileSync(manifest, "{not json");
    expect(checkRouteManifest(manifest).ok).toBe(false);
  });
});

describe("every PDF-parsing route is checked", () => {
  it("covers both /api/ingest and /api/ingest/selftest", () => {
    expect(PDF_ROUTES).toEqual(["api/ingest", "api/ingest/selftest"]);
  });

  it("reports each route independently", () => {
    const { root } = fixture([{ path: "pdf.worker.mjs", create: true }]);
    // Only /api/ingest has a manifest in this fixture; selftest must fail.
    const results = checkAllPdfRoutes(root);
    expect(results.find((r) => r.route === "api/ingest")?.ok).toBe(true);
    expect(results.find((r) => r.route === "api/ingest/selftest")?.ok).toBe(false);
  });
});

describe("verification is enforced by the normal build", () => {
  it("npm run build runs the verifier after next build", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const build = pkg.scripts.build ?? "";
    expect(build).toMatch(/^next build\b/);
    expect(build).toContain("scripts/verify-pdf-trace.mjs");
    // Order matters: the manifests only exist once next build has finished.
    expect(build.indexOf("next build")).toBeLessThan(build.indexOf("verify-pdf-trace"));
  });
});
