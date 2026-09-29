import type { Page } from "@/lib/domain/types";
import { putAssets } from "@/lib/persistence/assetStore";
import type { PageVisuals } from "@/lib/visuals/analyze";
import { renderPdfDocument } from "@/lib/visuals/browser";

/**
 * Reading one lecture PDF in the browser, shared by the upload screen and
 * "Add a PDF" on a lecture: text page by page from /api/ingest (server),
 * then every page rendered and its figures found and stored (browser).
 * Rendering is best effort — cards can still be made from the text.
 */

export interface ReadPdf {
  extracted: { id: string; title: string; pageCount: number; pages: Page[] };
  visuals: PageVisuals[];
  /** Page rendering or storage was unavailable; cards are text-only. */
  visualsFailed: boolean;
  figures: number;
}

export type ReadStage = { stage: "reading" } | { stage: "visuals"; done: number; total: number };

export class PdfReadError extends Error {}

export async function readLecturePdf(
  file: File,
  scope: { courseId: string; lectureId: string },
  onProgress: (progress: ReadStage) => void = () => {},
): Promise<ReadPdf> {
  onProgress({ stage: "reading" });
  const body = new FormData();
  body.set("file", file);
  body.set("courseId", scope.courseId);
  body.set("lectureId", scope.lectureId);
  let response: Response;
  try {
    response = await fetch("/api/ingest", { method: "POST", body });
  } catch {
    throw new PdfReadError("Could not reach MedRecall's servers. Check your connection and try again.");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof payload === "object" && payload !== null && "error" in payload ? String((payload as { error: unknown }).error) : "Could not read the PDF.";
    throw new PdfReadError(message);
  }
  const ingest = payload as { document: { id: string; title: string; pageCount: number; pages: Page[] } };
  const extracted = { id: ingest.document.id, title: ingest.document.title, pageCount: ingest.document.pageCount, pages: ingest.document.pages };

  let visuals: PageVisuals[] = [];
  let visualsFailed = false;
  let figures = 0;
  onProgress({ stage: "visuals", done: 0, total: extracted.pageCount });
  try {
    const rendered = await renderPdfDocument(await file.arrayBuffer(), {
      documentId: extracted.id,
      onProgress: (p) => onProgress({ stage: "visuals", done: p.done, total: p.total }),
    });
    visuals = rendered.visuals;
    figures = rendered.assets.filter((a) => a.kind === "figure").length;
    if (!(await putAssets(rendered.assets))) visualsFailed = true;
  } catch (cause) {
    // Cards do not depend on images; the reason stays in the console.
    console.warn("[medrecall] page rendering unavailable:", cause instanceof Error ? cause.message : cause);
    visualsFailed = true;
  }
  return { extracted, visuals: visualsFailed ? [] : visuals, visualsFailed, figures: visualsFailed ? 0 : figures };
}
