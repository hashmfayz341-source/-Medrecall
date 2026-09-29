import { NextResponse } from "next/server";
import { getGenerationProvider } from "@/lib/ai/generationProvider";
import { CARD_LANGUAGES } from "@/lib/domain/curriculum";
import type { CardLanguage, Page } from "@/lib/domain/types";
import { MAX_CARD_COUNT, type CardCount, type ExistingCard } from "@/lib/generation/generate";
import type { FigureCandidate, PageVisuals } from "@/lib/visuals/analyze";

/**
 * Card generation endpoint: lecture pages (already extracted by /api/ingest)
 * plus the figures found in them → DRAFT flashcards.
 *
 * Server-side for the same reason as /api/ingest: this is where a hosted
 * generator would run, so its key never reaches the browser. The response
 * is candidate material only; every card comes back DRAFT and enters the
 * curriculum through the same approval gate as everything else.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_PAGES = 600;
const MAX_DOCUMENTS = 20;

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 200_000): v is string => typeof v === "string" && v.length <= max;
const fraction = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

function pageShape(v: unknown): v is Page {
  return record(v) && Number.isInteger(v.number) && Number(v.number) >= 1 && str(v.title, 500) && str(v.text);
}
function figureShape(v: unknown): v is FigureCandidate {
  return record(v) && (v.kind === "raster" || v.kind === "diagram" || v.kind === "page") && record(v.region) &&
    fraction(v.region.x) && fraction(v.region.y) && fraction(v.region.w) && fraction(v.region.h) &&
    (v.caption === undefined || str(v.caption, 2000)) && (v.contentHash === undefined || str(v.contentHash, 64)) &&
    (v.labels === undefined || (Array.isArray(v.labels) && v.labels.length <= 200 && v.labels.every((l) => str(l, 500))));
}
function visualsShape(v: unknown): v is PageVisuals {
  return record(v) && Number.isInteger(v.pageNumber) && Number(v.pageNumber) >= 1 && Array.isArray(v.figures) &&
    v.figures.length <= 20 && v.figures.every(figureShape) && (v.textChars === undefined || typeof v.textChars === "number");
}
function existingShape(v: unknown): v is ExistingCard {
  return record(v) && str(v.id, 500) && str(v.title, 2000) && str(v.summary, 20_000);
}

export async function POST(request: Request) {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return bad("Request too large.", 413);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return bad("Expected a JSON body.");
  }
  if (!record(body)) return bad("Expected a JSON object.");
  const { courseId, lectureId, language, count, existing } = body;
  if (!str(courseId, 200) || !str(lectureId, 200) || !courseId || !lectureId) return bad("courseId and lectureId are required.");
  // `documents: [{ id, title, pages, visuals? }]`, or the single-document form `document` + `visuals`.
  const documents = Array.isArray(body.documents)
    ? body.documents
    : body.document !== undefined
      ? [{ ...(record(body.document) ? body.document : {}), visuals: body.visuals }]
      : null;
  if (!documents || documents.length === 0 || documents.length > MAX_DOCUMENTS) return bad(`documents must list 1 to ${MAX_DOCUMENTS} lecture documents.`);
  let totalPages = 0;
  for (const document of documents) {
    if (!record(document) || !str(document.id, 500) || !str(document.title, 500) || !Array.isArray(document.pages) ||
      document.pages.length === 0 || document.pages.length > MAX_PAGES || !document.pages.every(pageShape)) {
      return bad("each document must carry an id, a title and its pages.");
    }
    totalPages += document.pages.length;
    const visuals = document.visuals;
    if (visuals !== undefined && (!Array.isArray(visuals) || visuals.length > MAX_PAGES || !visuals.every(visualsShape))) {
      return bad("visuals must be a list of page figures.");
    }
  }
  if (totalPages > MAX_PAGES) return bad(`At most ${MAX_PAGES} pages per request.`);
  if (!(CARD_LANGUAGES as readonly string[]).includes(String(language))) return bad("language must be en, ar or ar-en.");
  let requested: CardCount;
  if (count === "auto") requested = "auto";
  else if (Number.isInteger(count) && Number(count) >= 1 && Number(count) <= MAX_CARD_COUNT) requested = Number(count);
  else return bad(`count must be "auto" or a whole number from 1 to ${MAX_CARD_COUNT}.`);
  if (existing !== undefined && (!Array.isArray(existing) || existing.length > 5000 || !existing.every(existingShape))) {
    return bad("existing must be a list of cards (id, title, summary).");
  }

  const result = await getGenerationProvider().generateCards({
    courseId,
    lectureId,
    documents: documents.map((d) => {
      const doc = d as { id: string; title: string; pages: Page[]; visuals?: PageVisuals[] };
      return { id: doc.id, title: doc.title, pages: doc.pages, visuals: doc.visuals ?? [] };
    }),
    language: language as CardLanguage,
    count: requested,
    existing: (existing ?? []) as ExistingCard[],
  });

  // Belt and braces: whatever the provider, nothing leaves here approved.
  const concepts = result.concepts.map((c) => ({ ...c, status: "DRAFT" as const }));
  return NextResponse.json({ ...result, concepts });
}
