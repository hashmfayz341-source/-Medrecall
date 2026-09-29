/** Types for scripts/make-unseen-fixture.mjs (used by the unseen-lecture tests). */
export const UNSEEN_FILE: string;
export function syntheticImage(width: number, height: number, seed: number, tint?: [number, number, number]): Buffer;
export const IMAGES: Record<string, [number, number, number, [number, number, number]]>;
export interface UnseenFigure {
  image: string;
  x: number;
  y: number;
  w: number;
  h: number;
  caption?: string;
}
export interface UnseenSlide {
  heading: string;
  lines: string[];
  figures?: UnseenFigure[];
}
export const SLIDES: UnseenSlide[];
export function buildUnseenPdf(): Buffer;
