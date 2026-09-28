import type { PageRegion } from "@/lib/domain/types";
import type { StoredAsset } from "@/lib/persistence/assetStore";
import {
  analyzeOperatorList,
  figureAssetId,
  pageAssetId,
  selectFigures,
  type OpsTable,
  type PageVisualAnalysis,
  type PageVisuals,
} from "./analyze";

/**
 * Browser-side page rendering and figure extraction with pdfjs.
 *
 * Runs in the browser on purpose: the uploaded file is already there, the
 * browser has a canvas, and the images end up in the browser's own asset
 * store — no image ever needs to leave the device or be stored on a server.
 * Text extraction stays server-side (`/api/ingest`), unchanged.
 *
 * Every page is rendered to a JPEG (so View source can show the slide) and
 * every selected figure is cropped from that rendering. Nothing is
 * synthesised: a figure is a region of an original page.
 */

export interface RenderProgress {
  stage: "loading" | "analyzing" | "rendering" | "done";
  done: number;
  total: number;
}

export interface RenderedDocument {
  pageCount: number;
  visuals: PageVisuals[];
  assets: StoredAsset[];
}

export interface RenderOptions {
  documentId: string;
  /** Longest side of a rendered page, in CSS pixels. */
  maxSide?: number;
  onProgress?: (progress: RenderProgress) => void;
  /** JPEG quality for page and figure images. */
  quality?: number;
}

// The legacy build: it carries the polyfills the current build leaves out
// (e.g. Map.prototype.getOrInsertComputed), which older iPad Safari and the
// test browser do not have. Same API, same version.
type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

/** Where scripts/copy-pdf-worker.mjs puts the worker. */
export const PDF_WORKER_URL = "/pdf.worker.min.mjs";

let pdfjsPromise: Promise<PdfjsModule> | null = null;

/** The browser build of pdfjs, loaded once, with its worker resolved by the bundler. */
async function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").then((pdfjs) => {
      // Served as a static file (scripts/copy-pdf-worker.mjs), the same
      // pdfjs version as the bundle.
      pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality));
}

function crop(source: HTMLCanvasElement, region: PageRegion): HTMLCanvasElement {
  const sx = Math.floor(region.x * source.width);
  const sy = Math.floor(region.y * source.height);
  const sw = Math.max(1, Math.ceil(region.w * source.width));
  const sh = Math.max(1, Math.ceil(region.h * source.height));
  const out = document.createElement("canvas");
  out.width = sw;
  out.height = sh;
  const ctx = out.getContext("2d");
  if (ctx) ctx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
  return out;
}

/**
 * Analyse and render every page of a PDF. Progress is reported per page so
 * the UI can show "Extracting visual material… 7 / 24".
 */
export async function renderPdfDocument(data: ArrayBuffer, options: RenderOptions): Promise<RenderedDocument> {
  const { documentId, maxSide = 1400, quality = 0.82, onProgress } = options;
  const report = (progress: RenderProgress) => onProgress?.(progress);
  report({ stage: "loading", done: 0, total: 1 });
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(data) });
  const doc = await task.promise;
  const OPS = pdfjs.OPS as unknown as OpsTable;
  const analyses: PageVisualAnalysis[] = [];
  const canvases = new Map<number, HTMLCanvasElement>();
  const createdAt = new Date().toISOString();
  const assets: StoredAsset[] = [];

  try {
    for (let n = 1; n <= doc.numPages; n++) {
      report({ stage: "analyzing", done: n - 1, total: doc.numPages });
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const ops = await page.getOperatorList();
      analyses.push(analyzeOperatorList(ops, OPS, { pageNumber: n, width: base.width, height: base.height }));

      report({ stage: "rendering", done: n - 1, total: doc.numPages });
      const scale = Math.min(2, maxSide / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas, canvasContext: ctx, viewport }).promise;
        canvases.set(n, canvas);
        const blob = await toBlob(canvas, quality);
        if (blob) {
          assets.push({ id: pageAssetId(documentId, n), documentId, pageNumber: n, kind: "page", width: canvas.width, height: canvas.height, blob, createdAt });
        }
      }
      page.cleanup();
    }

    const visuals = selectFigures(analyses);
    for (const pageVisuals of visuals) {
      const canvas = canvases.get(pageVisuals.pageNumber);
      if (!canvas) continue;
      for (let i = 0; i < pageVisuals.figures.length; i++) {
        const figure = pageVisuals.figures[i]!;
        const cropped = crop(canvas, figure.region);
        const blob = await toBlob(cropped, quality);
        if (blob) {
          assets.push({
            id: figureAssetId(documentId, pageVisuals.pageNumber, i),
            documentId,
            pageNumber: pageVisuals.pageNumber,
            kind: "figure",
            region: figure.region,
            width: cropped.width,
            height: cropped.height,
            blob,
            createdAt,
          });
        }
      }
    }
    report({ stage: "done", done: doc.numPages, total: doc.numPages });
    return { pageCount: doc.numPages, visuals, assets };
  } finally {
    await task.destroy();
  }
}
