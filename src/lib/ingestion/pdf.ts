import type { Page } from "@/lib/domain/types";

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

export interface ExtractedDocument {
  /** Stable id derived from the file name and content. */
  id: string;
  title: string;
  pageCount: number;
  pages: Page[];
}

/** FNV-1a — short, stable, dependency-free. Not used for security. */
export function contentHash(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
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
export function documentIdFor(fileName: string, bytes: Uint8Array): string {
  return `doc-${slugify(fileName)}-${contentHash(bytes)}`;
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
    !/[.!?]$/.test(first);

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
): Promise<ExtractedDocument> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const task = pdfjs.getDocument({
    data,
    useWorkerFetch: false,
    useSystemFonts: false,
    // Text extraction only — no glyph rendering, so font data is not needed.
    disableFontFace: true,
  });

  const doc = await task.promise;
  try {
    const pages: Page[] = [];
    // 1-indexed, ascending: page order is part of the contract.
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines = linesFromItems(content.items as TextItemLike[]);
      const { title, body } = splitHeading(lines, pageNumber);
      pages.push({ number: pageNumber, title, text: body });
    }

    return {
      id: documentIdFor(fileName, data),
      title: titleFromFileName(fileName),
      pageCount: doc.numPages,
      pages,
    };
  } finally {
    // destroy() lives on the loading task, not the document proxy.
    await task.destroy();
  }
}
