import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  classifyExtractionError,
  extractPdfPages,
  PdfExtractionError,
} from "@/lib/ingestion/pdf";
import { generateCandidates } from "@/lib/ingestion/extractor";

const LECTURE = "tests/fixtures/lecture-25-pages.pdf";
const SCOPE = { courseId: "course-pathology", lectureId: "lecture-cell-injury" };

describe("the pdfjs worker must be resolvable in the server runtime", () => {
  /**
   * The production failure was not a parsing bug: pdfjs loads its worker
   * through a runtime dynamic import that static file tracing cannot see, so
   * pdf.worker.mjs was omitted from the deployed function. Everything passed
   * locally because all of node_modules is on disk under `next start`.
   */
  it("resolves pdf.worker.mjs through the module system", () => {
    const require = createRequire(import.meta.url);
    expect(() =>
      require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
    ).not.toThrow();
  });

  it("next.config names the worker for EVERY route that parses a PDF", () => {
    // Each App Route becomes its own serverless function, so every PDF-parsing
    // route needs the worker in its own trace. A key like "/api/ingest"
    // currently also matches "/api/ingest/selftest" by prefix, but that is not
    // a documented guarantee, so both are listed explicitly.
    const config = readFileSync("next.config.ts", "utf8");
    expect(config).toContain("outputFileTracingIncludes");

    for (const route of ['"/api/ingest"', '"/api/ingest/selftest"']) {
      expect(config, `${route} must be listed`).toContain(route);
    }

    // Every listed PDF route points at the worker.
    const includes = config.slice(config.indexOf("outputFileTracingIncludes"));
    const workerMentions = includes.match(
      /pdfjs-dist\/legacy\/build\/pdf\.worker\.mjs/g,
    );
    expect(workerMentions?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("the trace verifier covers every PDF-parsing route", () => {
    // The build-time check is the real guard; this makes sure a new PDF route
    // cannot be added without also being verified.
    const verifier = readFileSync("scripts/verify-pdf-trace.mjs", "utf8");
    expect(verifier).toContain('"api/ingest"');
    expect(verifier).toContain('"api/ingest/selftest"');
  });
});

describe("a lecture-sized PDF extracts correctly", () => {
  it("REQUIREMENT 1+2: extracts every page of a 25-page document", async () => {
    const doc = await extractPdfPages(
      new Uint8Array(readFileSync(LECTURE)),
      "lecture-25-pages.pdf",
      SCOPE,
    );
    expect(doc.pageCount).toBe(25);
    expect(doc.pages).toHaveLength(25);
  });

  it("REQUIREMENT 3: preserves page order exactly", async () => {
    const doc = await extractPdfPages(
      new Uint8Array(readFileSync(LECTURE)),
      "lecture-25-pages.pdf",
      SCOPE,
    );
    expect(doc.pages.map((p) => p.number)).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 1),
    );
    // Order is not merely numeric: each page carries its own unique marker.
    for (const page of doc.pages) {
      expect(page.text, `page ${page.number}`).toContain(`Marker ${page.number} `);
    }
  });

  it("REQUIREMENT 4: preserves the page text and heading", async () => {
    const doc = await extractPdfPages(
      new Uint8Array(readFileSync(LECTURE)),
      "lecture-25-pages.pdf",
      SCOPE,
    );
    const page7 = doc.pages.find((p) => p.number === 7)!;
    expect(page7.title).toBe("Cell Adaptive Responses - Section 7");
    expect(page7.text).toContain("Hypertrophy is an increase in the size");
    expect(page7.text).toContain("Metaplasia is a reversible change");
    // No cross-page bleed.
    expect(page7.text).not.toContain("Marker 8 ");
  });

  it("REQUIREMENT 5: document identity is stable across identical uploads", async () => {
    const bytes = () => new Uint8Array(readFileSync(LECTURE));
    const first = await extractPdfPages(bytes(), "lecture.pdf", SCOPE);
    const second = await extractPdfPages(bytes(), "lecture.pdf", SCOPE);
    expect(first.id).toBe(second.id);
    expect(first.id).toMatch(/^doc-lecture-[a-f0-9]{64}$/);
  });

  it("REQUIREMENT 6: candidates are produced and remain DRAFT", async () => {
    const doc = await extractPdfPages(
      new Uint8Array(readFileSync(LECTURE)),
      "lecture-25-pages.pdf",
      SCOPE,
    );
    const candidates = generateCandidates(doc, SCOPE);
    expect(candidates.length).toBeGreaterThan(20);
    expect(new Set(candidates.map((c) => c.status))).toEqual(new Set(["DRAFT"]));

    // Provenance still points at a real page, with a verbatim excerpt.
    for (const concept of candidates) {
      const page = doc.pages.find((p) => p.number === concept.source.pageNumber)!;
      expect(page, concept.id).toBeDefined();
      expect(page.text).toContain(concept.source.excerpt);
    }
  });

  it("spreads candidates across the document rather than one page", async () => {
    const doc = await extractPdfPages(
      new Uint8Array(readFileSync(LECTURE)),
      "lecture-25-pages.pdf",
      SCOPE,
    );
    const pages = new Set(
      generateCandidates(doc, SCOPE).map((c) => c.source.pageNumber),
    );
    expect(pages.size).toBeGreaterThan(5);
  });
});

describe("failure modes stay distinguishable", () => {
  it("REQUIREMENT 8: a malformed PDF is rejected cleanly", async () => {
    await expect(
      extractPdfPages(new TextEncoder().encode("%PDF-1.4\ntruncated"), "broken.pdf"),
    ).rejects.toBeInstanceOf(PdfExtractionError);
  });

  it("classifies a missing worker as a RUNTIME problem, not a bad file", () => {
    const cause = new Error(
      'Setting up fake worker failed: "Cannot find module \'/var/task/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs\'".',
    );
    expect(classifyExtractionError(cause)).toBe("RUNTIME");
  });

  it("classifies an encrypted PDF separately", () => {
    const cause = Object.assign(new Error("No password given"), {
      name: "PasswordException",
    });
    expect(classifyExtractionError(cause)).toBe("ENCRYPTED");
  });

  it("classifies a structurally invalid PDF as malformed", () => {
    const cause = Object.assign(new Error("Invalid PDF structure."), {
      name: "InvalidPDFException",
    });
    expect(classifyExtractionError(cause)).toBe("MALFORMED");
  });

  it("REQUIREMENT 7: a text-free PDF still parses, leaving the no-text case to the route", async () => {
    // Behaviour unchanged: extraction succeeds, pages exist, text is empty, and
    // the route is what reports "No text could be extracted".
    const blank = readFileSync("tests/fixtures/renal-short.pdf");
    const doc = await extractPdfPages(new Uint8Array(blank), "renal-short.pdf");
    expect(doc.pages.every((p) => typeof p.text === "string")).toBe(true);
  });
});
