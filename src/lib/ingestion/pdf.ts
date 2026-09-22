import type { Page } from "@/lib/domain/types";
import { createHash } from "node:crypto";
import { createModuleRequire as createRequire } from "./moduleRequire";

/**
 * Page-by-page PDF text extraction.
 *
 * The whole point of this module is what it does NOT do: it never flattens the
 * document into one text blob. Page order and page numbers are preserved
 * because every Concept extracted later must be able to cite the exact page it
 * came from.
 *
 * Runs server-side (route handler) using the pdfjs legacy build, which needs no
 * worker and no DOM.
 */

/** Why extraction failed, so logs can tell these apart. */
export type ExtractionFailure =
  | "ENCRYPTED"
  | "MALFORMED"
  | "RUNTIME"
  | "UNKNOWN";

export class PdfExtractionError extends Error {
  readonly reason: ExtractionFailure;
  constructor(reason: ExtractionFailure, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "PdfExtractionError";
    this.reason = reason;
  }
}

/**
 * Classify a pdfjs failure.
 *
 * A worker or module-resolution failure is a deployment problem, not a bad
 * file, and must never be reported as "this is not a PDF" — that misdirected
 * a whole production investigation once already.
 */
export function classifyExtractionError(cause: unknown): ExtractionFailure {
  const name = (cause as { name?: string } | null)?.name ?? "";
  const message = cause instanceof Error ? cause.message : String(cause);

  if (name === "PasswordException" || /password/i.test(message)) return "ENCRYPTED";
  if (/fake worker|cannot find module|worker/i.test(message)) return "RUNTIME";
  if (name === "InvalidPDFException" || /invalid pdf|pdf structure/i.test(message)) {
    return "MALFORMED";
  }
  return "UNKNOWN";
}

export interface ExtractedDocument {
  /** Stable id derived from the file name and content. */
  id: string;
  title: string;
  pageCount: number;
  pages: Page[];
}

/** Content identity must not collide and inherit an unrelated approval. */
export function contentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.pdf$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "document";
}

/** A document id that is stable for the same file uploaded twice. */
export function documentIdFor(
  fileName: string,
  bytes: Uint8Array,
  scope?: { courseId: string; lectureId: string },
): string {
  const identity = createHash("sha256")
    .update(JSON.stringify([fileName, scope?.courseId ?? "", scope?.lectureId ?? ""]))
    .update(bytes)
    .digest("hex");
  return `doc-${slugify(fileName)}-${identity}`;
}

/** Turn a file name into a readable document title. */
export function titleFromFileName(fileName: string): string {
  const base = fileName.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim();
  if (!base) return "Untitled document";
  return base.charAt(0).toUpperCase() + base.slice(1);
}

interface TextItemLike {
  str?: string;
  hasEOL?: boolean;
}

/** Rebuild visual lines from pdfjs text items using their end-of-line flags. */
export function linesFromItems(items: readonly TextItemLike[]): string[] {
  const lines: string[] = [];
  let current = "";
  for (const item of items) {
    if (typeof item.str === "string") current += item.str;
    if (item.hasEOL) {
      lines.push(current.trim());
      current = "";
    }
  }
  if (current.trim().length > 0) lines.push(current.trim());
  return lines.filter((line) => line.length > 0);
}

/**
 * A page's heading, if the first line looks like one: short and not a
 * sentence. Otherwise the page is titled by its number.
 */
export function splitHeading(
  lines: readonly string[],
  pageNumber: number,
): { title: string; body: string } {
  const [first, ...rest] = lines;
  const looksLikeHeading =
    first !== undefined &&
    first.length > 0 &&
    first.length <= 90 &&
    rest.length > 0 &&
    !/[.!?]$/.test(first) &&
    !/\b(is|are|was|were|has|have|causes|leads|consumes|requires)\b/i.test(first);

  if (looksLikeHeading) {
    return { title: first, body: rest.join(" ").trim() };
  }
  return { title: `Page ${pageNumber}`, body: lines.join(" ").trim() };
}

/**
 * Extract every page of a PDF, in order.
 *
 * @throws if the bytes are not a readable PDF.
 */
export async function extractPdfPages(
  data: Uint8Array,
  fileName: string,
  scope?: { courseId: string; lectureId: string },
): Promise<ExtractedDocument> {
  // pdfjs transfers/detaches data.buffer, including with its Node fake worker.
  // Compute identity while the uploaded bytes still exist.
  const id = documentIdFor(fileName, data, scope);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  // Point pdfjs at the worker explicitly. Left to itself it derives a path
  // from its own module URL, which is fragile in a traced serverless bundle;
  // resolving through the module system fails loudly and traceably instead.
  try {
    const require = createRequire(import.meta.url);
    pdfjs.GlobalWorkerOptions.workerSrc = require.resolve(
      "pdfjs-dist/legacy/build/pdf.worker.mjs",
    );
  } catch {
    // Fall back to pdfjs's own resolution rather than failing outright.
  }

  const task = pdfjs.getDocument({
    data,
    useWorkerFetch: false,
    useSystemFonts: false,
    // Text extraction only — no glyph rendering, so font data is not needed.
    disableFontFace: true,
  });

  try {
    let doc;
    try {
      doc = await task.promise;
    } catch (cause) {
      throw new PdfExtractionError(
        classifyExtractionError(cause),
        cause instanceof Error ? cause.message : String(cause),
        cause,
      );
    }

    const pages: Page[] = [];
    // 1-indexed, ascending: page order is part of the contract.
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines = linesFromItems(content.items as TextItemLike[]);
      const { title } = splitHeading(lines, pageNumber);
      // Keep the heading too: extraction must never delete source text.
      pages.push({ number: pageNumber, title, text: lines.join("\n") });
      page.cleanup();
    }

    return {
      id,
      title: titleFromFileName(fileName),
      pageCount: doc.numPages,
      pages,
    };
  } finally {
    // destroy() lives on the loading task, not the document proxy.
    await task.destroy();
  }
}
