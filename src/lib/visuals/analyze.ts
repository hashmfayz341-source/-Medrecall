import type { PageRegion } from "@/lib/domain/types";

/**
 * Visual material of a PDF, found deterministically from pdfjs operator
 * lists. Pure: no canvas, no DOM, no pdfjs import — the browser renderer
 * (./browser.ts) feeds it real operator lists, and the unit tests feed it
 * synthetic ones.
 *
 * What counts as a figure, and what is rejected as decoration:
 *
 * - A raster image drawn large enough to be looked at (at least
 *   `MIN_FIGURE_AREA` of the page and `MIN_FIGURE_SIDE` of its width/height,
 *   with a real intrinsic size) is a figure candidate. Tiny images (icons),
 *   thin strips (rules, bars) and pixel-sized placeholders are not.
 * - An image drawn at the same place and size on several pages is branding
 *   (a logo, a template frame) and is rejected everywhere it appears.
 * - A page with substantial vector drawing (paths) and no accepted raster
 *   image is a diagram; its figure region is the drawn area, or the whole
 *   page when the drawing spans it.
 * - Nothing is ever invented: every figure is a region of an original page.
 */

/** The subset of pdfjs `OPS` this module reads. */
export interface OpsTable {
  transform: number;
  save: number;
  restore: number;
  paintImageXObject: number;
  paintInlineImageXObject: number;
  paintImageMaskXObject: number;
  constructPath: number;
  showText: number;
}

export interface OperatorListLike {
  fnArray: ArrayLike<number>;
  argsArray: ArrayLike<unknown>;
}

export interface DetectedImage {
  objId: string;
  /** Where it is drawn, as fractions of the page. */
  region: PageRegion;
  /** Intrinsic pixel size when pdfjs reports it (0 when unknown). */
  width: number;
  height: number;
}

export interface PageVisualAnalysis {
  pageNumber: number;
  /** Page size in PDF user units (points). */
  width: number;
  height: number;
  images: DetectedImage[];
  /** Number of path constructions drawn on the page. */
  pathOps: number;
  /** Union of drawn path bounds, as fractions of the page; null without paths. */
  pathBounds: PageRegion | null;
  /** Glyphs shown on the page. */
  textChars: number;
}

export type FigureKind = "raster" | "diagram" | "page";

export interface FigureCandidate {
  kind: FigureKind;
  region: PageRegion;
}

export interface PageVisuals {
  pageNumber: number;
  figures: FigureCandidate[];
  textChars: number;
}

/** A raster image must cover at least this fraction of the page area. */
export const MIN_FIGURE_AREA = 0.03;
/** …and at least this fraction of the page's width and height. */
export const MIN_FIGURE_SIDE = 0.12;
/** …and be at least this many pixels on each side, when the size is known. */
export const MIN_INTRINSIC_PX = 48;
/** An image drawn identically on this many pages (or this share of them) is decoration. */
export const REPEATED_MIN_PAGES = 3;
export const REPEATED_SHARE = 0.3;
/** A page with at least this many path constructions is a diagram candidate. */
export const MIN_DIAGRAM_PATHS = 25;
/** A region covering this much of the page is treated as the whole page. */
export const WHOLE_PAGE_AREA = 0.9;

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, t: Matrix): Matrix {
  // t applied first, then m (pdfjs `transform` post-multiplies the CTM).
  return [
    m[0] * t[0] + m[2] * t[1],
    m[1] * t[0] + m[3] * t[1],
    m[0] * t[2] + m[2] * t[3],
    m[1] * t[2] + m[3] * t[3],
    m[0] * t[4] + m[2] * t[5] + m[4],
    m[1] * t[4] + m[3] * t[5] + m[5],
  ];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Bounding box of points in user space → fractions of the page, top-left origin. */
function regionOf(points: [number, number][], width: number, height: number): PageRegion {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const x0 = clamp(minX / width);
  const x1 = clamp(maxX / width);
  // PDF user space has its origin at the bottom-left.
  const y0 = clamp(1 - maxY / height);
  const y1 = clamp(1 - minY / height);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** pdfjs hands out plain arrays or typed arrays; both are fine. */
function numbers(value: unknown, length: number): number[] | null {
  if (typeof value !== "object" || value === null || !("length" in value)) return null;
  const list = Array.from(value as ArrayLike<unknown>);
  if (list.length !== length || !list.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return list as number[];
}

/** Walk one page's operator list, tracking the CTM, and record what is drawn where. */
export function analyzeOperatorList(
  ops: OperatorListLike,
  OPS: OpsTable,
  page: { pageNumber: number; width: number; height: number },
): PageVisualAnalysis {
  const { width, height } = page;
  let ctm: Matrix = IDENTITY;
  const stack: Matrix[] = [];
  const images: DetectedImage[] = [];
  let pathOps = 0;
  let textChars = 0;
  const pathPoints: [number, number][] = [];

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === OPS.save) {
      stack.push(ctm);
    } else if (fn === OPS.restore) {
      ctm = stack.pop() ?? IDENTITY;
    } else if (fn === OPS.transform) {
      const m = numbers(args, 6);
      if (m) ctm = multiply(ctm, m as Matrix);
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
      const a = Array.isArray(args) ? args : [];
      const objId = typeof a[0] === "string" ? a[0] : `inline-${i}`;
      const w = typeof a[1] === "number" ? a[1] : 0;
      const h = typeof a[2] === "number" ? a[2] : 0;
      // An image occupies the unit square under the current transform.
      const corners = [apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 0, 1), apply(ctm, 1, 1)];
      images.push({ objId, region: regionOf(corners, width, height), width: w, height: h });
    } else if (fn === OPS.constructPath) {
      pathOps++;
      const a = Array.isArray(args) ? args : [];
      const minMax = numbers(a[2], 4);
      if (minMax) {
        const [x0, y0, x1, y1] = minMax as [number, number, number, number];
        pathPoints.push(apply(ctm, x0, y0), apply(ctm, x1, y0), apply(ctm, x0, y1), apply(ctm, x1, y1));
      }
    } else if (fn === OPS.showText) {
      const a = Array.isArray(args) ? args : [];
      const glyphs = a[0];
      if (Array.isArray(glyphs)) textChars += glyphs.length;
      else if (typeof glyphs === "string") textChars += glyphs.length;
    }
  }

  return {
    pageNumber: page.pageNumber,
    width,
    height,
    images,
    pathOps,
    pathBounds: pathPoints.length > 0 ? regionOf(pathPoints, width, height) : null,
    textChars,
  };
}

const area = (r: PageRegion) => r.w * r.h;
const signature = (r: PageRegion) =>
  [r.x, r.y, r.w, r.h].map((v) => Math.round(v * 200)).join(":");

/** Whether an image is big enough to be a figure rather than an icon or a rule. */
export function isFigureSized(image: DetectedImage): boolean {
  const r = image.region;
  if (area(r) < MIN_FIGURE_AREA || r.w < MIN_FIGURE_SIDE || r.h < MIN_FIGURE_SIDE) return false;
  if ((image.width > 0 && image.width < MIN_INTRINSIC_PX) || (image.height > 0 && image.height < MIN_INTRINSIC_PX)) return false;
  return true;
}

/**
 * Choose the figures worth putting on a card, page by page, rejecting
 * decoration. Deterministic and purely geometric — no image content is
 * inspected, so nothing is judged "medical" here; the generator decides
 * whether a page's text supports a visual card.
 */
export function selectFigures(pages: readonly PageVisualAnalysis[]): PageVisuals[] {
  // Images repeated at the same place and size across pages are branding.
  const seenOn = new Map<string, Set<number>>();
  for (const page of pages) {
    for (const image of page.images) {
      const key = signature(image.region);
      const set = seenOn.get(key) ?? new Set<number>();
      set.add(page.pageNumber);
      seenOn.set(key, set);
    }
  }
  const repeatedLimit = Math.max(REPEATED_MIN_PAGES, Math.ceil(pages.length * REPEATED_SHARE));
  const isRepeated = (image: DetectedImage) => (seenOn.get(signature(image.region))?.size ?? 0) >= repeatedLimit;

  return pages.map((page) => {
    const figures: FigureCandidate[] = [];
    const seenRegions = new Set<string>();
    for (const image of page.images) {
      if (!isFigureSized(image) || isRepeated(image)) continue;
      const key = signature(image.region);
      if (seenRegions.has(key)) continue;
      seenRegions.add(key);
      if (area(image.region) >= WHOLE_PAGE_AREA) figures.push({ kind: "page", region: { x: 0, y: 0, w: 1, h: 1 } });
      else figures.push({ kind: "raster", region: image.region });
    }
    if (figures.length === 0 && page.pathOps >= MIN_DIAGRAM_PATHS && page.pathBounds) {
      const bounds = page.pathBounds;
      if (area(bounds) >= MIN_FIGURE_AREA && bounds.w >= MIN_FIGURE_SIDE && bounds.h >= MIN_FIGURE_SIDE) {
        figures.push(
          area(bounds) >= WHOLE_PAGE_AREA
            ? { kind: "page", region: { x: 0, y: 0, w: 1, h: 1 } }
            : { kind: "diagram", region: pad(bounds) },
        );
      }
    }
    return { pageNumber: page.pageNumber, figures, textChars: page.textChars };
  });
}

/** A little breathing room around a cropped region, inside the page. */
function pad(r: PageRegion, margin = 0.015): PageRegion {
  const x = Math.max(0, r.x - margin);
  const y = Math.max(0, r.y - margin);
  return { x, y, w: Math.min(1 - x, r.w + 2 * margin), h: Math.min(1 - y, r.h + 2 * margin) };
}

/** Asset ids, so every stored page and figure is addressable from a card. */
export const pageAssetId = (documentId: string, pageNumber: number) => `${documentId}#p${pageNumber}`;
export const figureAssetId = (documentId: string, pageNumber: number, index: number) => `${documentId}#p${pageNumber}#f${index}`;
