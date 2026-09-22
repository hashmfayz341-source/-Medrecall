import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { extractPdfPages, type ExtractedDocument } from "@/lib/ingestion/pdf";
import {
  buildChunks,
  generateCandidates,
  toSourceDocument,
} from "@/lib/ingestion/extractor";
import {
  addIngestedDocument,
  applyOverrides,
  createOverrides,
  setConceptStatus,
  setConceptStatuses,
} from "@/lib/domain/curriculum";
import { pathologyCurriculum, DEMO_LECTURE_1 } from "@/lib/content/pathology";
import {
  conceptsForLecture,
  createLearnerState,
  getNextStep,
  markChunkTaught,
  recordAttempt,
} from "@/lib/engine/tutor";
import type { Concept, Curriculum, LearnerState } from "@/lib/domain/types";

const T0 = new Date("2026-03-01T09:00:00.000Z");
let doc: ExtractedDocument;
let candidates: Concept[];

beforeAll(async () => {
  const bytes = new Uint8Array(readFileSync("tests/fixtures/cell-injury.pdf"));
  doc = await extractPdfPages(bytes, "cell-injury.pdf", {
    courseId: "course-pathology",
    lectureId: DEMO_LECTURE_1,
  });
  candidates = generateCandidates(doc, {
    courseId: "course-pathology",
    lectureId: DEMO_LECTURE_1,
  });
});

function ingestedCurriculum(decide: (ov: ReturnType<typeof createOverrides>) => ReturnType<typeof createOverrides>): Curriculum {
  const ov = addIngestedDocument(
    createOverrides(),
    {
      lectureId: DEMO_LECTURE_1,
      document: toSourceDocument(doc, DEMO_LECTURE_1),
      chunks: buildChunks(doc, DEMO_LECTURE_1, candidates, 2),
      ingestedAt: T0.toISOString(),
    },
    candidates,
  );
  return applyOverrides(pathologyCurriculum, decide(ov));
}

/** Walk lecture 1 to the first TEACH step belonging to the ingested document. */
function teachStepForIngested(curriculum: Curriculum) {
  let learner: LearnerState = createLearnerState();
  for (let i = 0; i < 60; i++) {
    const step = getNextStep(curriculum, learner, DEMO_LECTURE_1, T0);
    if (step.kind === "TEACH") {
      if (step.chunk.documentId === doc.id) return step;
      learner = markChunkTaught(curriculum, learner, step.chunk.id);
      continue;
    }
    if (step.kind === "LECTURE_COMPLETE" || step.kind === "AWAITING_APPROVAL") return step;
    learner = recordAttempt(curriculum, learner, {
      conceptId: step.concept.id,
      itemId: step.item.id,
      answer: step.item.requiredKeywords.map((g) => g[0] ?? "").join(" "),
      context: step.context,
      chunkId: step.chunk.id,
      now: T0,
    }).learner;
  }
  throw new Error("never reached the ingested chunk");
}

describe("C1 regression: unapproved text never reaches teaching", () => {
  it("a partly-approved generated page teaches only the approved sentences", () => {
    const approved = candidates[0]!;
    const discarded = candidates[1]!;
    const curriculum = ingestedCurriculum((ov) =>
      setConceptStatus(setConceptStatus(ov, approved.id, "ACTIVE"), discarded.id, "DISCARDED"),
    );

    const step = teachStepForIngested(curriculum);
    expect(step.kind).toBe("TEACH");
    if (step.kind !== "TEACH") return;

    const payload = JSON.stringify(step);
    // The approved sentence is taught...
    expect(payload).toContain(approved.summary);
    // ...and every unapproved one is absent, from prose AND from pages.
    for (const other of candidates) {
      if (other.id === approved.id) continue;
      expect(payload, `${other.id} (${other.status}) leaked into TEACH`).not.toContain(
        other.summary,
      );
    }
  });

  it("the discarded sentence is absent even though it shares a page with an approved one", () => {
    const samePage = candidates.filter((c) => c.source.pageNumber === 1);
    expect(samePage.length).toBeGreaterThan(1);

    const curriculum = ingestedCurriculum((ov) =>
      setConceptStatus(
        setConceptStatus(ov, samePage[0]!.id, "ACTIVE"),
        samePage[1]!.id,
        "DISCARDED",
      ),
    );
    const step = teachStepForIngested(curriculum);
    if (step.kind !== "TEACH") throw new Error("expected TEACH");

    const pageText = step.pages.map((p) => p.text).join("\n");
    expect(pageText).toContain(samePage[0]!.source.excerpt);
    expect(pageText).not.toContain(samePage[1]!.source.excerpt);
  });

  it("approving everything restores the full generated content", () => {
    const curriculum = ingestedCurriculum((ov) =>
      setConceptStatuses(ov, candidates.map((c) => c.id), "ACTIVE"),
    );
    const step = teachStepForIngested(curriculum);
    if (step.kind !== "TEACH") throw new Error("expected TEACH");
    const onThisChunk = candidates.filter((c) =>
      step.chunk.pageNumbers.includes(c.source.pageNumber),
    );
    for (const concept of onThisChunk) {
      expect(JSON.stringify(step)).toContain(concept.summary);
    }
  });

  it("the stored generated chunk never contains candidate sentences", () => {
    const curriculum = ingestedCurriculum((ov) => ov);
    const lecture = curriculum.course.lectures.find((l) => l.id === DEMO_LECTURE_1)!;
    for (const chunk of lecture.chunks.filter((c) => c.documentId === doc.id)) {
      for (const concept of candidates) {
        expect(chunk.explanation).not.toContain(concept.summary);
      }
    }
  });
});

describe("Milestone 1 authored teaching is preserved", () => {
  it("serves the authored chunk title, prose and pages exactly as written", () => {
    const step = getNextStep(pathologyCurriculum, createLearnerState(), DEMO_LECTURE_1, T0);
    expect(step.kind).toBe("TEACH");
    if (step.kind !== "TEACH") return;

    const authored = pathologyCurriculum.course.lectures[0]!.chunks[0]!;
    expect(step.chunk.title).toBe(authored.title);
    expect(step.chunk.explanation).toBe(authored.explanation);
    expect(authored.generated).toBeUndefined();

    // All of the authored chunk's source pages are served, with their headings.
    const authoredPages = pathologyCurriculum.course.lectures[0]!.documents[0]!.pages.filter(
      (p) => authored.pageNumbers.includes(p.number),
    );
    expect(step.pages.map((p) => p.number)).toEqual(authoredPages.map((p) => p.number));
    expect(step.pages.map((p) => p.title)).toEqual(authoredPages.map((p) => p.title));
    expect(step.pages.map((p) => p.text)).toEqual(authoredPages.map((p) => p.text));
  });

  it("no authored chunk's prose contains a DRAFT or DISCARDED concept's summary", () => {
    const unapproved = pathologyCurriculum.concepts.filter((c) => c.status !== "ACTIVE");
    expect(unapproved.length).toBeGreaterThan(0);
    for (const lecture of pathologyCurriculum.course.lectures) {
      for (const chunk of lecture.chunks) {
        for (const concept of unapproved) {
          expect(chunk.explanation, `${chunk.id} vs ${concept.id}`).not.toContain(
            concept.summary,
          );
        }
      }
    }
  });

  it("the authored lecture still completes and unlocks the next one", () => {
    let learner = createLearnerState();
    for (let i = 0; i < 60; i++) {
      const step = getNextStep(pathologyCurriculum, learner, DEMO_LECTURE_1, T0);
      if (step.kind === "LECTURE_COMPLETE") break;
      if (step.kind === "AWAITING_APPROVAL") throw new Error("unexpected");
      if (step.kind === "TEACH") {
        learner = markChunkTaught(pathologyCurriculum, learner, step.chunk.id);
        continue;
      }
      learner = recordAttempt(pathologyCurriculum, learner, {
        conceptId: step.concept.id,
        itemId: step.item.id,
        answer: step.item.requiredKeywords.map((g) => g[0] ?? "").join(" "),
        context: step.context,
        chunkId: step.chunk.id,
        now: T0,
      }).learner;
    }
    expect(learner.completedLectureIds).toContain(DEMO_LECTURE_1);
    expect(conceptsForLecture(pathologyCurriculum, DEMO_LECTURE_1).length).toBe(5);
  });
});
