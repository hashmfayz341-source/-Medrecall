import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pathologyCurriculum as C } from "@/lib/content/pathology";
import {
  addGeneratedConcepts,
  addIngestedDocument,
  addLecture,
  applyOverrides,
  chunkOrderOffset,
  createOverrides,
  migrateOverrides,
  setConceptStatuses,
  type CurriculumOverrides,
} from "@/lib/domain/curriculum";
import type { Lecture } from "@/lib/domain/types";
import { recordCardRating, studyCardsForLecture } from "@/lib/engine/study";
import { createLearnerState } from "@/lib/engine/tutor";
import { factsOverlap } from "@/lib/generation/facts";
import { generateCards, type ExistingCard } from "@/lib/generation/generate";
import { buildChunks, toSourceDocument } from "@/lib/ingestion/extractor";
import { extractPdfPages } from "@/lib/ingestion/pdf";

/**
 * Review blocker 5 of PR #10: Generate more must know which lecture
 * document(s) it reads. A lecture with A.pdf and B.pdf can generate from B
 * alone or from all its material; B's cards carry B's provenance, A's cards
 * and their FSRS history are untouched, and nothing is generated twice.
 */

const COURSE = C.course.id;
const LECTURE = "lecture-cell-injury-multi";
const T0 = new Date("2026-06-01T09:00:00.000Z");

async function read(file: string) {
  const doc = await extractPdfPages(new Uint8Array(readFileSync(`tests/fixtures/${file}`)), file, { courseId: COURSE, lectureId: LECTURE });
  return { id: doc.id, title: doc.title, pageCount: doc.pageCount, pages: doc.pages };
}

const lecture: Lecture = { id: LECTURE, courseId: COURSE, title: "Cell Injury", order: 9, documents: [], chunks: [] };
const existingOf = (o: CurriculumOverrides): ExistingCard[] => o.concepts.filter((c) => c.lectureId === LECTURE).map((c) => ({ id: c.id, title: c.title, summary: c.summary }));

async function scenario() {
  const A = await read("Cell Injury.pdf");
  const B = await read("Inflammation.pdf");
  // Generate A.
  const fromA = generateCards({ courseId: COURSE, lectureId: LECTURE, documents: [A], language: "en", count: 6, existing: [] });
  let o = addIngestedDocument(addLecture(createOverrides(), lecture), { lectureId: LECTURE, document: toSourceDocument(A, LECTURE), chunks: buildChunks(A, LECTURE, fromA.concepts, 0), ingestedAt: T0.toISOString() }, fromA.concepts);
  o = setConceptStatuses(o, fromA.concepts.map((c) => c.id), "ACTIVE");
  // Study one A card.
  const curriculum = applyOverrides(C, o);
  const studied = studyCardsForLecture(curriculum, LECTURE)[0]!;
  const learner = recordCardRating(curriculum, createLearnerState(), { conceptId: studied.concept.id, itemId: studied.item.id, rating: "GOOD", now: T0 }).learner;
  // Add B (no cards yet), as "Add a PDF" does.
  o = addIngestedDocument(o, { lectureId: LECTURE, document: toSourceDocument(B, LECTURE), chunks: buildChunks(B, LECTURE, [], chunkOrderOffset(applyOverrides(C, o), LECTURE)), ingestedAt: T0.toISOString() }, []);
  return { A, B, fromA, o, learner, studied };
}

describe("Fix 5: Generate more across a lecture's documents", () => {
  it("generating from B alone gives cards with B's provenance and leaves A's cards, ids and FSRS history untouched", async () => {
    const { A, B, fromA, o: before, learner, studied } = await scenario();
    const fromB = generateCards({ courseId: COURSE, lectureId: LECTURE, documents: [B], language: "en", count: 5, existing: existingOf(before) });
    expect(fromB.concepts).toHaveLength(5);
    for (const c of fromB.concepts) {
      expect(c.source.documentId).toBe(B.id);
      expect(c.id.startsWith(`${B.id}-p`)).toBe(true);
      const page = B.pages.find((p) => p.number === c.source.pageNumber)!;
      for (const line of c.source.excerpt.split("\n")) expect(page.text).toContain(line);
    }
    const o = addGeneratedConcepts(before, [B.id], fromB.concepts);
    // A untouched: same concepts, same statuses, same ids.
    const aConcepts = (x: CurriculumOverrides) => x.concepts.filter((c) => c.source.documentId === A.id);
    expect(aConcepts(o)).toEqual(aConcepts(before));
    expect(aConcepts(o).map((c) => c.id)).toEqual(fromA.concepts.map((c) => c.id));
    expect(o.statusById).toEqual(before.statusById);
    // A's studied card still has its FSRS record and is still studyable as before.
    const after = applyOverrides(C, o);
    expect(after.concepts.find((c) => c.id === studied.concept.id)!.status).toBe("ACTIVE");
    expect(learner.cards![studied.item.id]!.reviews).toBe(1);
    // B's new cards joined B's chunks, not A's.
    const bEntry = o.ingested.find((i) => i.document.id === B.id)!;
    const aEntry = o.ingested.find((i) => i.document.id === A.id)!;
    for (const c of fromB.concepts) expect(bEntry.chunks.some((ch) => ch.conceptIds.includes(c.id))).toBe(true);
    expect(aEntry.chunks).toEqual(before.ingested.find((i) => i.document.id === A.id)!.chunks);
  });

  it("generating from all lecture material avoids duplicates across both documents and never regenerates existing cards", async () => {
    const { A, B, o: before } = await scenario();
    const fromB = generateCards({ courseId: COURSE, lectureId: LECTURE, documents: [B], language: "en", count: 3, existing: existingOf(before) });
    const withB = addGeneratedConcepts(before, [B.id], fromB.concepts);
    const all = generateCards({ courseId: COURSE, lectureId: LECTURE, documents: [A, B], language: "en", count: "auto", existing: existingOf(withB) });
    const existingIds = new Set(withB.concepts.map((c) => c.id));
    expect(all.concepts.length).toBeGreaterThan(0);
    expect(all.concepts.some((c) => c.source.documentId === A.id)).toBe(true);
    expect(all.concepts.some((c) => c.source.documentId === B.id)).toBe(true);
    for (const c of all.concepts) {
      expect(existingIds.has(c.id)).toBe(false);
      for (const e of withB.concepts) expect(factsOverlap({ text: e.summary }, { text: c.summary })).toBe(false);
    }
    // Cards are in document order (A before B), each with its own document's pages.
    const docOrder = all.concepts.map((c) => (c.source.documentId === A.id ? 0 : 1));
    expect([...docOrder].sort()).toEqual(docOrder);
    const o = addGeneratedConcepts(withB, [A.id, B.id], all.concepts);
    expect(o.concepts.length).toBe(withB.concepts.length + all.concepts.length);
    // Running it again adds nothing.
    const again = generateCards({ courseId: COURSE, lectureId: LECTURE, documents: [A, B], language: "en", count: 100, existing: existingOf(o) });
    const ids = new Set(o.concepts.map((c) => c.id));
    for (const c of again.concepts) {
      expect(ids.has(c.id)).toBe(false);
      for (const e of o.concepts) expect(factsOverlap({ text: e.summary }, { text: c.summary })).toBe(false);
    }
    expect(addGeneratedConcepts(o, [A.id, B.id], all.concepts)).toEqual(o);
  });

  it("a concept for a document outside the chosen set is not added", async () => {
    const { A, B, o } = await scenario();
    const fromB = generateCards({ courseId: COURSE, lectureId: LECTURE, documents: [B], language: "en", count: 2, existing: existingOf(o) });
    expect(addGeneratedConcepts(o, [A.id], fromB.concepts)).toEqual(o);
    expect(addGeneratedConcepts(o, B.id, fromB.concepts).concepts.length).toBe(o.concepts.length + 2); // single-id form still works
  });

  it("both documents and all cards survive a store round-trip (refresh)", async () => {
    const { A, B, o: before } = await scenario();
    const fromB = generateCards({ courseId: COURSE, lectureId: LECTURE, documents: [B], language: "en", count: 4, existing: existingOf(before) });
    const o = addGeneratedConcepts(before, [B.id], fromB.concepts);
    const reloaded = migrateOverrides(JSON.parse(JSON.stringify(o)))!;
    expect(reloaded).toEqual(o);
    const composed = applyOverrides(C, reloaded).course.lectures.find((l) => l.id === LECTURE)!;
    expect(composed.documents.map((d) => d.id)).toEqual([A.id, B.id]);
  });

  it("the single-document request form still works (the upload screen's)", async () => {
    const { A } = await scenario();
    const single = generateCards({ courseId: COURSE, lectureId: LECTURE, document: A, visuals: [], language: "en", count: 3, existing: [] });
    const listed = generateCards({ courseId: COURSE, lectureId: LECTURE, documents: [A], language: "en", count: 3, existing: [] });
    expect(single.concepts).toEqual(listed.concepts);
  });
});
