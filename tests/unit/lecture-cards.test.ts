import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pathologyCurriculum as C } from "@/lib/content/pathology";
import {
  addGeneratedConcepts,
  addIngestedDocument,
  addLecture,
  applyOverrides,
  cardImageShape,
  createOverrides,
  lectureLanguage,
  migrateOverrides,
  renameLecture,
  sanitizeOverrides,
  setConceptStatus,
  setLectureLanguage,
  type CurriculumOverrides,
} from "@/lib/domain/curriculum";
import { lectureIdFor, titleFromFileName } from "@/lib/domain/titles";
import type { Concept, Lecture } from "@/lib/domain/types";
import { buildStudyQueue, recordCardRating, studyCardsForLecture } from "@/lib/engine/study";
import { createLearnerState } from "@/lib/engine/tutor";
import { extractFacts, factsOverlap, splitMechanism, splitSuperlative } from "@/lib/generation/facts";
import { AUTO_MIN_SCORE, generateCards, type GeneratedCards } from "@/lib/generation/generate";
import { hasArabic, templatesFor } from "@/lib/generation/language";
import { buildChunks } from "@/lib/ingestion/extractor";
import { extractPdfPages } from "@/lib/ingestion/pdf";
import { analyzeOperatorList, figureAssetId, pageAssetId, selectFigures, type OpsTable, type PageVisualAnalysis, type PageVisuals } from "@/lib/visuals/analyze";

/**
 * Lecture → flashcards: the primary product flow.
 *
 * Deterministic generation from a real fixture (Cell Injury.pdf: slide
 * headings, bullet lists, mechanism sentences, a repeated logo, a raster
 * histology image, a vector flowchart), figure selection from real pdfjs
 * operator lists, language modes, requested and AUTO counts, provenance,
 * Generate more, and the curriculum-level plumbing that persists it all.
 */

const FIXTURE = "tests/fixtures/Cell Injury.pdf";
const COURSE = C.course.id;
const LECTURE = "lecture-cell-injury-upload";

async function fixtureDocument() {
  const data = new Uint8Array(readFileSync(FIXTURE));
  return extractPdfPages(data, "Cell Injury.pdf", { courseId: COURSE, lectureId: LECTURE });
}

/** Real operator lists from pdfjs's legacy (Node) build, as the browser renderer would feed them. */
async function fixtureVisuals(): Promise<PageVisuals[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(FIXTURE)), useWorkerFetch: false, useSystemFonts: false, disableFontFace: true });
  const doc = await task.promise;
  const analyses: PageVisualAnalysis[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      analyses.push(analyzeOperatorList(await page.getOperatorList(), pdfjs.OPS as unknown as OpsTable, { pageNumber: n, width: viewport.width, height: viewport.height }));
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return selectFigures(analyses);
}

let cached: { document: Awaited<ReturnType<typeof fixtureDocument>>; visuals: PageVisuals[] } | null = null;
async function fixture() {
  if (!cached) cached = { document: await fixtureDocument(), visuals: await fixtureVisuals() };
  return cached;
}

function generate(overrides: Partial<Parameters<typeof generateCards>[0]>, base?: { document: Awaited<ReturnType<typeof fixtureDocument>>; visuals: PageVisuals[] }): GeneratedCards {
  const f = base!;
  return generateCards({ courseId: COURSE, lectureId: LECTURE, document: f.document, visuals: f.visuals, language: "en", count: "auto", existing: [], ...overrides });
}

describe("lecture title", () => {
  it("comes from the file name", () => {
    expect(titleFromFileName("Cell Injury.pdf")).toBe("Cell Injury");
    expect(titleFromFileName("cell_injury-lecture 03.PDF")).toBe("Cell injury lecture 03");
    expect(titleFromFileName(".pdf")).toBe("Untitled document");
    expect(lectureIdFor("Cell Injury", 1000)).toBe("lecture-cell-injury-rs");
    expect(lectureIdFor("الالتهاب", 1000)).toMatch(/^lecture-.+-rs$/);
  });

  it("a user lecture can be renamed; authored ones are not stored and stay as they are", () => {
    const lecture: Lecture = { id: "lecture-x", courseId: COURSE, title: "Cell Injury", order: 3, documents: [], chunks: [] };
    let o = addLecture(createOverrides(), lecture);
    expect(addLecture(o, lecture)).toEqual(o); // idempotent
    o = renameLecture(o, "lecture-x", "  Cell Injury (Pathology 201) ");
    expect(o.lectures[0]!.title).toBe("Cell Injury (Pathology 201)");
    expect(renameLecture(o, "lecture-x", "   ")).toEqual(o);
    expect(renameLecture(o, "lecture-cell-injury", "Nope")).toEqual(o);
    expect(applyOverrides(C, o).course.lectures.find((l) => l.id === "lecture-cell-injury")!.title).toBe(C.course.lectures[0]!.title);
  });
});

describe("visual material", () => {
  it("finds the raster figures and the vector flowchart, and rejects the repeated logo", async () => {
    const { visuals } = await fixture();
    const byPage = new Map(visuals.map((v) => [v.pageNumber, v.figures]));
    expect(byPage.get(5)).toMatchObject([{ kind: "raster" }]);
    expect(byPage.get(6)).toMatchObject([{ kind: "raster" }]);
    expect(byPage.get(4)).toMatchObject([{ kind: "diagram" }]);
    // The logo is on every page; the title, list and reference pages have nothing else.
    for (const n of [1, 2, 3, 7, 8, 9, 10]) expect(byPage.get(n)).toEqual([]);
    const raster = byPage.get(5)![0]!.region;
    expect(raster.w).toBeGreaterThan(0.4);
    expect(raster.h).toBeGreaterThan(0.2);
  });

  it("decorative images are rejected: tiny, thin, repeated or pixel placeholders", () => {
    const OPS: OpsTable = { transform: 12, save: 10, restore: 11, paintImageXObject: 85, paintInlineImageXObject: 86, paintImageMaskXObject: 83, constructPath: 91, showText: 44 };
    const page = (pageNumber: number, draws: [number, number, number, number, number, number, number, number][]): PageVisualAnalysis => {
      const fnArray: number[] = [];
      const argsArray: unknown[] = [];
      for (const [a, b, c, d, e, f, w, h] of draws) {
        fnArray.push(OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore);
        argsArray.push(null, [a, b, c, d, e, f], [`img${e}`, w, h], null);
      }
      return analyzeOperatorList({ fnArray, argsArray }, OPS, { pageNumber, width: 612, height: 792 });
    };
    const logo: [number, number, number, number, number, number, number, number] = [26, 0, 0, 26, 560, 750, 24, 24];
    const banner: [number, number, number, number, number, number, number, number] = [612, 0, 0, 6, 0, 0, 1200, 12];
    const photo: [number, number, number, number, number, number, number, number] = [300, 0, 0, 225, 156, 120, 800, 600];
    const pixel: [number, number, number, number, number, number, number, number] = [300, 0, 0, 225, 156, 120, 1, 1];
    const pages = [page(1, [logo, banner]), page(2, [logo, photo]), page(3, [logo, pixel]), page(4, [logo])];
    const selected = selectFigures(pages);
    expect(selected.map((p) => p.figures.length)).toEqual([0, 1, 0, 0]);
    expect(selected[1]!.figures[0]).toMatchObject({ kind: "raster" });
    // The same photo repeated on most pages is a template, not a figure.
    const repeated = selectFigures([page(1, [photo]), page(2, [photo]), page(3, [photo]), page(4, [logo])]);
    expect(repeated.every((p) => p.figures.length === 0)).toBe(true);
    // Asset ids are addressable from cards.
    expect(pageAssetId("doc-1", 5)).toBe("doc-1#p5");
    expect(figureAssetId("doc-1", 5, 0)).toBe("doc-1#p5#f0");
  });
});

describe("facts", () => {
  it("recognises mechanisms, superlatives and lists, and skips administrative slides", async () => {
    const { document } = await fixture();
    const facts = extractFacts(document.pages);
    expect(facts.some((f) => f.pageNumber === 1)).toBe(false); // title slide
    expect(facts.some((f) => f.pageNumber === 10)).toBe(false); // references / thank you
    expect(facts.find((f) => f.kind === "list" && f.pageNumber === 2)?.items).toEqual([
      "Hypoxia", "Physical agents", "Chemical agents and drugs", "Infectious agents", "Immunologic reactions", "Genetic derangements", "Nutritional imbalances",
    ]);
    expect(facts.find((f) => f.kind === "list" && f.pageNumber === 8)?.items).toHaveLength(6);
    expect(facts.filter((f) => f.kind === "mechanism").map((f) => f.consequence)).toContain("failure of the Na+/K+ ATPase pump");
    expect(facts.find((f) => f.kind === "superlative" && f.pageNumber === 3)).toMatchObject({ term: "Hypoxia", consequence: "the most common cause of cell injury" });
    expect(splitMechanism("ATP depletion causes failure of the pump.")).toEqual({ cause: "ATP depletion", connector: "causes", consequence: "failure of the pump" });
    expect(splitMechanism("Hypoxia is the most common cause of cell injury.")).toBeNull(); // "cause" as a noun
    expect(splitSuperlative("Hypoxia is the most common cause of cell injury.")).toEqual({ subject: "Hypoxia", rest: "the most common cause of cell injury" });
    expect(factsOverlap({ text: "Hypoxia is the most common cause of cell injury." }, { text: "Hypoxia is the commonest cause of cell injury" })).toBe(true);
    expect(factsOverlap({ text: "cells" }, { text: "cell" })).toBe(false); // too short for a word-overlap match
  });
});

describe("generation", () => {
  it("honours a requested count, never pads, and reports the shortfall", async () => {
    const f = await fixture();
    const ten = generate({ count: 10 }, f);
    expect(ten.concepts).toHaveLength(10);
    expect(ten.shortfall).toBe(0);
    const forty = generate({ count: 40 }, f);
    expect(forty.concepts.length).toBeLessThan(40);
    expect(forty.concepts.length).toBe(forty.available - (forty.available - forty.concepts.length));
    expect(forty.shortfall).toBe(40 - forty.concepts.length);
    // Never the same statement twice, never the same question twice.
    const prompts = forty.concepts.map((c) => c.retrievalItems[0]!.prompt);
    expect(new Set(prompts).size).toBe(prompts.length);
    const texts = forty.concepts.map((c) => c.summary);
    expect(new Set(texts).size).toBe(texts.length);
    expect(generate({ count: 9999 }, f).concepts.length).toBe(forty.concepts.length);
  });

  it("AUTO keeps the important material once, in lecture order", async () => {
    const f = await fixture();
    const auto = generate({ count: "auto" }, f);
    expect(auto.requested).toBe("auto");
    expect(auto.shortfall).toBe(0);
    expect(auto.concepts.length).toBeGreaterThan(8);
    const pages = auto.concepts.map((c) => c.source.pageNumber);
    expect([...pages].sort((a, b) => a - b)).toEqual(pages);
    // Everything AUTO chose scored at least the threshold; everything is a card type that tests one idea.
    const kinds = new Set(auto.concepts.map((c) => c.retrievalItems[0]!.kind));
    expect(kinds.has("MECHANISM")).toBe(true);
    expect(kinds.has("IMAGE")).toBe(true);
    expect(AUTO_MIN_SCORE).toBeGreaterThan(1);
  });

  it("every card is DRAFT, cites its page verbatim, and visual cards point at an original figure with provenance", async () => {
    const f = await fixture();
    const out = generate({ count: 40 }, f);
    for (const c of out.concepts) {
      expect(c.status).toBe("DRAFT");
      expect(c.source.documentId).toBe(f.document.id);
      expect(c.retrievalItems).toHaveLength(1);
      const page = f.document.pages.find((p) => p.number === c.source.pageNumber)!;
      // The excerpt is the page's own text (a sentence, or its bullet items).
      for (const line of c.source.excerpt.split("\n")) expect(page.text).toContain(line);
      expect(c.retrievalItems[0]!.conceptId).toBe(c.id);
      expect(cardImageShape(c.retrievalItems[0]!.image ?? { assetId: "x", documentId: "d", pageNumber: 1, placement: "front" })).toBe(true);
    }
    const imageCards = out.concepts.filter((c) => c.retrievalItems[0]!.kind === "IMAGE");
    expect(imageCards.map((c) => c.source.pageNumber)).toEqual([4, 5, 6]);
    for (const c of imageCards) {
      const image = c.retrievalItems[0]!.image!;
      expect(image.placement).toBe("front");
      expect(image.documentId).toBe(f.document.id);
      expect(image.pageNumber).toBe(c.source.pageNumber);
      expect(image.assetId).toBe(figureAssetId(f.document.id, c.source.pageNumber, 0));
      expect(image.region).toBeDefined();
    }
    // The mechanism on the flowchart slide carries the diagram with its answer.
    const mechanism = out.concepts.find((c) => c.source.pageNumber === 4 && c.retrievalItems[0]!.kind === "MECHANISM")!;
    expect(mechanism.retrievalItems[0]!.image).toMatchObject({ placement: "back", pageNumber: 4 });
    // Text-only facts stay text cards.
    const apoptosis = out.concepts.find((c) => c.title === "Apoptosis")!;
    expect(apoptosis.retrievalItems[0]!.image).toBeUndefined();
  });

  it("English, Arabic and mixed modes scaffold the question; medical terms and the source stay as written", async () => {
    const f = await fixture();
    const en = generate({ count: 40, language: "en" }, f);
    const ar = generate({ count: 40, language: "ar" }, f);
    const mixed = generate({ count: 40, language: "ar-en" }, f);
    const prompt = (out: GeneratedCards, title: string) => out.concepts.find((c) => c.title === title)!.retrievalItems[0]!.prompt;
    expect(prompt(en, "Hypoxia")).toBe("What is the most common cause of cell injury?");
    expect(prompt(ar, "Hypoxia")).toBe("ما هو most common cause of cell injury؟");
    expect(prompt(mixed, "Apoptosis")).toBe("ما هو Apoptosis؟");
    expect(hasArabic(prompt(ar, "Apoptosis"))).toBe(true);
    expect(hasArabic(prompt(en, "Apoptosis"))).toBe(false);
    expect(prompt(mixed, "ATP depletion")).toBe("أكمل الآلية: ATP depletion causes ___.");
    expect(prompt(en, "Patterns of necrosis")).toBe("List: Patterns of necrosis");
    expect(prompt(ar, "Patterns of necrosis")).toBe("عدّد: Patterns of necrosis");
    // The answer side is the lecture's verbatim text in every mode.
    for (const out of [en, ar, mixed]) {
      expect(out.concepts.find((c) => c.title === "Apoptosis")!.retrievalItems[0]!.explanation).toBe("Apoptosis is programmed cell death mediated by caspases.");
    }
    expect(templatesFor("ar").figure(5)).toBe(templatesFor("ar-en").figure(5));
    expect(templatesFor("en").figure(5)).toBe("What does this figure (page 5) show?");
    expect(templatesFor("ar").figure(5)).toContain("5");
  });

  it("Generate more adds only new facts and keeps existing cards' FSRS history", async () => {
    const f = await fixture();
    const first = generate({ count: 5 }, f);
    const existing = first.concepts.map((c) => ({ id: c.id, title: c.title, summary: c.summary }));
    const more = generate({ count: 5, existing }, f);
    expect(more.concepts).toHaveLength(5);
    const ids = new Set(first.concepts.map((c) => c.id));
    for (const c of more.concepts) {
      expect(ids.has(c.id)).toBe(false);
      for (const e of first.concepts) expect(factsOverlap({ text: e.summary }, { text: c.summary })).toBe(false);
    }
    const everything = generate({ count: "auto" }, f);
    const all = everything.concepts.map((c) => ({ id: c.id, title: c.title, summary: c.summary }));
    expect(generate({ count: 20, existing: all }, f).concepts.filter((c) => all.some((e) => e.id === c.id))).toEqual([]);

    // Through the curriculum: store the first batch, study one card, then append the next batch.
    const lecture: Lecture = { id: LECTURE, courseId: COURSE, title: "Cell Injury", order: 3, documents: [], chunks: [] };
    const chunks = buildChunks(f.document, LECTURE, first.concepts, 0);
    let o = addIngestedDocument(addLecture(createOverrides(), lecture), { lectureId: LECTURE, document: { id: f.document.id, lectureId: LECTURE, title: f.document.title, pages: f.document.pages }, chunks, ingestedAt: "2026-06-01T09:00:00.000Z", visuals: f.visuals }, first.concepts);
    o = setConceptStatus(o, first.concepts[0]!.id, "ACTIVE");
    const curriculum = applyOverrides(C, o);
    const card = studyCardsForLecture(curriculum, LECTURE)[0]!;
    const rated = recordCardRating(curriculum, createLearnerState(), { conceptId: card.concept.id, itemId: card.item.id, rating: "GOOD", now: new Date("2026-06-01T10:00:00.000Z") }).learner;
    const before = rated.cards![card.item.id]!;

    o = addGeneratedConcepts(o, f.document.id, more.concepts);
    expect(o.concepts).toHaveLength(10);
    expect(addGeneratedConcepts(o, f.document.id, more.concepts)).toEqual(o); // idempotent
    const after = applyOverrides(C, o);
    expect(after.concepts.find((c) => c.id === card.concept.id)!.status).toBe("ACTIVE");
    expect(rated.cards![card.item.id]).toEqual(before);
    expect(studyCardsForLecture(after, LECTURE)).toHaveLength(1); // the new ones are drafts
    // New concepts joined the chunk covering their page, so the Tutor can teach them once approved.
    const stored = o.ingested[0]!;
    for (const c of more.concepts) {
      expect(stored.chunks.some((chunk) => chunk.pageNumbers.includes(c.source.pageNumber) && chunk.conceptIds.includes(c.id))).toBe(true);
    }
  });

  it("DRAFT and DISCARDED cards never reach Study; approved ones do", async () => {
    const f = await fixture();
    const out = generate({ count: 6 }, f);
    const lecture: Lecture = { id: LECTURE, courseId: COURSE, title: "Cell Injury", order: 3, documents: [], chunks: [] };
    let o = addIngestedDocument(addLecture(createOverrides(), lecture), { lectureId: LECTURE, document: { id: f.document.id, lectureId: LECTURE, title: f.document.title, pages: f.document.pages }, chunks: buildChunks(f.document, LECTURE, out.concepts, 0), ingestedAt: "2026-06-01T09:00:00.000Z" }, out.concepts);
    expect(studyCardsForLecture(applyOverrides(C, o), LECTURE)).toHaveLength(0);
    o = setConceptStatus(o, out.concepts[0]!.id, "ACTIVE");
    o = setConceptStatus(o, out.concepts[1]!.id, "ACTIVE");
    o = setConceptStatus(o, out.concepts[2]!.id, "DISCARDED");
    const cards = studyCardsForLecture(applyOverrides(C, o), LECTURE);
    expect(cards.map((c) => c.concept.id)).toEqual([out.concepts[0]!.id, out.concepts[1]!.id]);
    const queue = buildStudyQueue(applyOverrides(C, o), createLearnerState(), LECTURE, new Date());
    expect(queue.counts.new).toBe(2);
  });
});

describe("curriculum plumbing", () => {
  it("card language is persisted per lecture, validated per entry, and defaults to English", () => {
    let o = setLectureLanguage(createOverrides(), "lecture-a", "ar-en");
    o = setLectureLanguage(o, "lecture-b", "ar");
    expect(lectureLanguage(o, "lecture-a")).toBe("ar-en");
    expect(lectureLanguage(o, "lecture-c")).toBe("en");
    expect(setLectureLanguage(o, "lecture-a", "fr" as never)).toEqual(o);
    const migrated = migrateOverrides({ ...o, lectureSettings: { ...o.lectureSettings, bad: { language: "xx" }, worse: 5 } })!;
    expect(migrated.lectureSettings).toEqual({ "lecture-a": { language: "ar-en" }, "lecture-b": { language: "ar" } });
    expect(migrateOverrides({ version: 4, statusById: {} })!.lectureSettings).toEqual({});
    expect(migrateOverrides({ version: 4, statusById: {}, lectureSettings: "nope" })).not.toBeNull();
  });

  it("a malformed card image or figure record is dropped on its own; the card and the document stay", async () => {
    const f = await fixture();
    const out = generate({ count: 40 }, f);
    const imageCard = out.concepts.find((c) => c.retrievalItems[0]!.image)!;
    const lecture: Lecture = { id: LECTURE, courseId: COURSE, title: "Cell Injury", order: 3, documents: [], chunks: [] };
    const o: CurriculumOverrides = addIngestedDocument(addLecture(createOverrides(), lecture), { lectureId: LECTURE, document: { id: f.document.id, lectureId: LECTURE, title: f.document.title, pages: f.document.pages }, chunks: [], ingestedAt: "2026-06-01T09:00:00.000Z", visuals: f.visuals }, [imageCard]);
    const stored = JSON.parse(JSON.stringify(o)) as { concepts: Concept[]; ingested: { visuals?: unknown }[] };
    (stored.concepts[0]!.retrievalItems[0] as { image: unknown }).image = { assetId: 5 };
    stored.ingested[0]!.visuals = [{ pageNumber: "x" }];
    const result = sanitizeOverrides(stored)!;
    expect(result.dropped).toEqual(["ingested[0].visuals", "concepts[0].retrievalItems[0].image"]);
    expect(result.overrides.concepts[0]!.retrievalItems[0]!.image).toBeUndefined();
    expect(result.overrides.ingested[0]!.document.id).toBe(f.document.id);
    expect(result.overrides.ingested[0]!.visuals).toBeUndefined();
    // Valid ones pass through.
    expect(migrateOverrides(JSON.parse(JSON.stringify(o)))!.concepts[0]!.retrievalItems[0]!.image).toEqual(imageCard.retrievalItems[0]!.image);
    expect(migrateOverrides(JSON.parse(JSON.stringify(o)))!.ingested[0]!.visuals).toEqual(f.visuals);
  });
});
