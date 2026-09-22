import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractPdfPages } from "@/lib/ingestion/pdf";
import { buildChunks, generateCandidates, toSourceDocument } from "@/lib/ingestion/extractor";
import { addIngestedDocument, applyOverrides, createOverrides, editConcept, migrateOverrides, setConceptStatus, setConceptStatuses } from "@/lib/domain/curriculum";
import { createLearnerState, getNextStep, markChunkTaught, recordAttempt, reconcile } from "@/lib/engine/tutor";
import { gradeAnswer } from "@/lib/grading";
import { DeterministicProvider } from "@/lib/ai/deterministic";
import type { Concept, Curriculum } from "@/lib/domain/types";
import { makePdf } from "../fixtures/make-pdf";

const now = new Date("2026-09-22T12:00:00Z");
function fixture() {
  const document = { id: "doc-audit", title: "Audit PDF", pageCount: 1, pages: [{ number: 1, title: "Audit", text: "Hypoxia is the first approved fact. Necrosis is an unapproved secret. Apoptosis is a discarded secret." }] };
  const candidates = generateCandidates(document, { courseId: "course", lectureId: "lecture" });
  const chunks = buildChunks(document, "lecture", candidates, 0);
  const base: Curriculum = { course: { id: "course", title: "Audit", description: "", lectures: [{ id: "lecture", title: "First", courseId: "course", order: 1, documents: [], chunks: [] }, { id: "later", title: "Later", courseId: "course", order: 2, documents: [], chunks: [] }] }, concepts: [] };
  const overrides = addIngestedDocument(createOverrides(), { lectureId: "lecture", document: toSourceDocument(document, "lecture"), chunks, ingestedAt: now.toISOString() }, candidates);
  return { base, overrides, document, candidates, chunks };
}

describe("independent M2 audit: real PDFs", () => {
  it("different PDF bytes with the same filename never reuse content identity", async () => {
    const first = await extractPdfPages(new Uint8Array(readFileSync("tests/fixtures/cell-injury.pdf")), "lecture.pdf");
    const second = await extractPdfPages(new Uint8Array(readFileSync("tests/fixtures/renal-short.pdf")), "lecture.pdf");
    expect(first.id).not.toBe(second.id);
  });

  it("keeps a one-line page even without final punctuation", async () => {
    const doc = await extractPdfPages(makePdf([["Hypoxia is a cause of cell injury"]]), "one.pdf");
    expect(doc.pages[0]!.text).toContain("Hypoxia is a cause of cell injury");
    expect(generateCandidates(doc, { courseId: "course", lectureId: "lecture" })).toHaveLength(1);
  });

  it("preserves empty pages and exact ordering across 100 pages", async () => {
    const pages = Array.from({ length: 100 }, (_, i) => i === 40 ? [] : [`Marker ${i + 1} is a unique page.`]);
    const doc = await extractPdfPages(makePdf(pages), "many.pdf");
    expect(doc.pages.map(p => p.number)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(doc.pages[40]!.text).toBe("");
    expect(doc.pages[99]!.text).toContain("Marker 100");
  });

  it("keeps headings, Unicode and medical notation in stored source text", async () => {
    const sentence = "Na⁺/K⁺ ATPase is inhibited by β-blockers at 5 μM.";
    const doc = await extractPdfPages(makePdf([["Medical symbols", sentence]]), "symbols.pdf");
    expect(doc.pages[0]!.text).toContain(sentence);
    expect(doc.pages[0]!.text).toContain("Medical symbols");
  });

  it("rejects zero bytes and malformed input", async () => {
    await expect(extractPdfPages(new Uint8Array(), "empty.pdf")).rejects.toBeDefined();
    await expect(extractPdfPages(new TextEncoder().encode("%PDF-1.4\ntruncated"), "broken.pdf")).rejects.toBeDefined();
  });
});

describe("independent M2 audit: gate and lifecycle", () => {
  it("never carries draft/discarded text in the TEACH payload", () => {
    const { base, overrides, candidates } = fixture();
    const decisions = setConceptStatus(setConceptStatus(overrides, candidates[0]!.id, "ACTIVE"), candidates[2]!.id, "DISCARDED");
    const curriculum = applyOverrides(base, decisions);
    const step = getNextStep(curriculum, createLearnerState(), "lecture", now);
    expect(step.kind).toBe("TEACH");
    expect(JSON.stringify(step)).not.toContain("unapproved secret");
    expect(JSON.stringify(step)).not.toContain("discarded secret");
  });

  it("provider entry points reject non-active concepts", async () => {
    const { candidates, chunks, document } = fixture();
    const provider = new DeterministicProvider();
    for (const status of ["DRAFT", "DISCARDED"] as const) {
      const concept: Concept = { ...candidates[0]!, status };
      await expect(provider.generateRetrievalItems(concept)).rejects.toThrow();
      await expect(provider.generateTeachingExplanation({ chunk: chunks[0]!, concepts: [concept], pages: document.pages })).rejects.toThrow();
      await expect(provider.generateRemediation({ concept, item: concept.retrievalItems[0]!, learnerAnswer: "", grade: gradeAnswer(concept.retrievalItems[0]!, "") })).rejects.toThrow();
    }
  });

  it("a corrected draft teaches and grades the correction without rewriting provenance", () => {
    const { base, overrides, candidates } = fixture();
    const target = candidates[0]!;
    const changed = editConcept(overrides, target.id, { title: "Oxygen deficiency", summary: "Oxygen deficiency is a reduction in tissue oxygen availability." });
    const curriculum = applyOverrides(base, setConceptStatus(changed, target.id, "ACTIVE"));
    const concept = curriculum.concepts[0]!;
    expect(concept.source).toEqual(target.source);
    expect(concept.retrievalItems.every(i => i.explanation === concept.summary)).toBe(true);
    expect(gradeAnswer(concept.retrievalItems[0]!, "Oxygen deficiency").correct).toBe(true);
    const step = getNextStep(curriculum, createLearnerState(), "lecture", now);
    expect(JSON.stringify(step)).toContain(concept.summary);
  });

  it("late approval reopens a completed chunk and teaches the newly active concept", () => {
    const { base, overrides, candidates } = fixture();
    const approved = setConceptStatus(overrides, candidates[0]!.id, "ACTIVE");
    const curriculum = applyOverrides(base, approved);
    let learner = markChunkTaught(curriculum, createLearnerState(), curriculum.course.lectures[0]!.chunks[0]!.id);
    learner = recordAttempt(curriculum, learner, { conceptId: candidates[0]!.id, itemId: candidates[0]!.retrievalItems[0]!.id, answer: candidates[0]!.title, context: "INITIAL", now }).learner;
    expect(learner.completedLectureIds).toContain("lecture");
    const later = applyOverrides(base, setConceptStatus(approved, candidates[1]!.id, "ACTIVE"));
    const next = getNextStep(later, learner, "lecture", now);
    expect(next.kind).toBe("TEACH");
    if (next.kind === "TEACH") expect(next.concepts.map(c => c.id)).toContain(candidates[1]!.id);
    expect(reconcile(later, learner).completedLectureIds).not.toContain("lecture");
  });

  it("empty/discarded sections do not strand approved material later in the lecture", () => {
    const { base, overrides, candidates, chunks } = fixture();
    overrides.ingested[0]!.chunks = [
      { ...chunks[0]!, id: "empty", order: 1, conceptIds: [] },
      { ...chunks[0]!, id: "discarded", order: 2, conceptIds: [candidates[0]!.id] },
      { ...chunks[0]!, id: "ready", order: 3, conceptIds: [candidates[1]!.id] },
    ];
    const decisions = setConceptStatus(setConceptStatus(overrides, candidates[0]!.id, "DISCARDED"), candidates[1]!.id, "ACTIVE");
    const step = getNextStep(applyOverrides(base, decisions), createLearnerState(), "lecture", now);
    expect(step.kind).toBe("TEACH");
    if (step.kind === "TEACH") expect(step.chunk.id).toBe("ready");
  });

  it("all-draft and all-discarded lectures never earn completion", () => {
    const { base, overrides, candidates, chunks } = fixture();
    for (const status of ["DRAFT", "DISCARDED"] as const) {
      const curriculum = applyOverrides(base, setConceptStatuses(overrides, candidates.map(c => c.id), status));
      const learner = markChunkTaught(curriculum, createLearnerState(), chunks[0]!.id);
      expect(getNextStep(curriculum, learner, "lecture", now).kind).toBe("AWAITING_APPROVAL");
      expect(learner.completedLectureIds).toEqual([]);
    }
  });

  it("invalid persisted arrays/status values fail closed instead of crashing hydration", () => {
    for (const patch of [{ concepts: {} }, { lectures: "bad" }, { ingested: [null] }, { statusById: { x: "PUBLISHED" } }, { concepts: [{ id: "bad" }] }]) {
      expect(migrateOverrides({ ...createOverrides(), ...patch })).toBeNull();
    }
  });

  it("legacy colliding upload identities must be reviewed again without revoking authored approvals", () => {
    const { overrides, candidates } = fixture();
    const legacy = "doc-lecture-811c9dc5";
    overrides.version = 2;
    overrides.ingested[0]!.document.id = legacy;
    overrides.concepts = candidates.map(c => ({ ...c, source: { ...c.source, documentId: legacy } }));
    overrides.statusById[candidates[0]!.id] = "ACTIVE";
    overrides.statusById["c-draft-lysosomal"] = "ACTIVE";
    const migrated = migrateOverrides(overrides)!;
    expect(migrated.statusById[candidates[0]!.id]).toBe("DRAFT");
    expect(migrated.statusById["c-draft-lysosomal"]).toBe("ACTIVE");
    expect(overrides.statusById[candidates[0]!.id]).toBe("ACTIVE");
    const reviewedAgain = setConceptStatus(migrated, candidates[0]!.id, "ACTIVE");
    expect(migrateOverrides(reviewedAgain)!.statusById[candidates[0]!.id]).toBe("ACTIVE");
  });
});
