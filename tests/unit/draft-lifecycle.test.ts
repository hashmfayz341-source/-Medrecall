import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  editConcept,
  setConceptStatus,
  setConceptStatuses,
  migrateOverrides,
  type CurriculumOverrides,
} from "@/lib/domain/curriculum";
import { pathologyCurriculum, DEMO_LECTURE_1 } from "@/lib/content/pathology";
import { ConceptNotActiveError } from "@/lib/domain/errors";
import { assertActive } from "@/lib/domain/gate";
import { createProgress } from "@/lib/domain/mastery";
import { applyRetrievalToMastery } from "@/lib/domain/mastery";
import { newSchedule, scheduleAfterAttempt } from "@/lib/engine/scheduler";
import { buildTodayQueue } from "@/lib/engine/priority";
import {
  conceptsForChunk,
  conceptsForLecture,
  createLearnerState,
  getNextStep,
  isLectureUnlocked,
  markChunkTaught,
  recordAttempt,
  selectInterleavedConcept,
} from "@/lib/engine/tutor";
import {
  LocalStorageCurriculumRepository,
  CURRICULUM_STORAGE_KEY,
} from "@/lib/persistence/curriculumStore";
import { LocalStorageLearnerRepository } from "@/lib/persistence/localStorage";
import type { Concept, Curriculum, LearnerState, RetrievalItem } from "@/lib/domain/types";

const COURSE = "course-pathology";
const T0 = new Date("2026-02-01T09:00:00.000Z");

let doc: ExtractedDocument;
let candidates: Concept[];
let baseOverrides: CurriculumOverrides;

/** An answer guaranteed to satisfy a generated item's keyword groups. */
function answerFor(item: RetrievalItem): string {
  return item.requiredKeywords.map((group) => group[0] ?? "").join(" ");
}

function installFakeStorage() {
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
  return store;
}

beforeAll(async () => {
  const bytes = new Uint8Array(readFileSync("tests/fixtures/cell-injury.pdf"));
  doc = await extractPdfPages(bytes, "cell-injury.pdf");
  candidates = generateCandidates(doc, {
    courseId: COURSE,
    lectureId: DEMO_LECTURE_1,
  });

  // Ingested into Cell Injury, after the two authored chunks.
  baseOverrides = addIngestedDocument(
    createOverrides(),
    {
      lectureId: DEMO_LECTURE_1,
      document: toSourceDocument(doc, DEMO_LECTURE_1),
      chunks: buildChunks(doc, DEMO_LECTURE_1, candidates, 2),
      ingestedAt: T0.toISOString(),
    },
    candidates,
  );
});

function curriculumWith(overrides: CurriculumOverrides): Curriculum {
  return applyOverrides(pathologyCurriculum, overrides);
}

describe("ingested material joins the existing curriculum", () => {
  it("adds the document and its chunks to the target lecture", () => {
    const curriculum = curriculumWith(baseOverrides);
    const lecture = curriculum.course.lectures.find((l) => l.id === DEMO_LECTURE_1)!;
    expect(lecture.documents.some((d) => d.id === doc.id)).toBe(true);
    expect(lecture.chunks.length).toBeGreaterThan(2);
  });

  it("does not create a parallel curriculum: authored concepts survive", () => {
    const curriculum = curriculumWith(baseOverrides);
    expect(curriculum.concepts.find((c) => c.id === "c-atp-depletion")).toBeDefined();
    expect(curriculum.concepts.length).toBe(
      pathologyCurriculum.concepts.length + candidates.length,
    );
  });

  it("re-ingesting the same document replaces rather than duplicates", () => {
    const twice = addIngestedDocument(
      baseOverrides,
      {
        lectureId: DEMO_LECTURE_1,
        document: toSourceDocument(doc, DEMO_LECTURE_1),
        chunks: buildChunks(doc, DEMO_LECTURE_1, candidates, 2),
        ingestedAt: T0.toISOString(),
      },
      candidates,
    );
    expect(twice.ingested).toHaveLength(1);
    expect(twice.concepts).toHaveLength(candidates.length);
  });
});

describe("the approval gate holds for ingested drafts", () => {
  let curriculum: Curriculum;
  let draft: Concept;

  beforeEach(() => {
    curriculum = curriculumWith(baseOverrides);
    draft = curriculum.concepts.find((c) => c.id === candidates[0]!.id)!;
    expect(draft.status).toBe("DRAFT");
  });

  it("REQUIREMENT 5: DRAFT concepts cannot enter teaching", () => {
    const lecture = curriculum.course.lectures.find((l) => l.id === DEMO_LECTURE_1)!;
    const ingestedChunk = lecture.chunks.find((c) => c.documentId === doc.id)!;

    expect(ingestedChunk.conceptIds).toContain(draft.id);
    expect(conceptsForChunk(curriculum, ingestedChunk)).toHaveLength(0);
    expect(() => assertActive(draft, "teaching")).toThrow(ConceptNotActiveError);
  });

  it("REQUIREMENT 6: DRAFT concepts cannot enter retrieval", () => {
    const learner = createLearnerState();
    expect(() =>
      recordAttempt(curriculum, learner, {
        conceptId: draft.id,
        itemId: draft.retrievalItems[0]!.id,
        answer: answerFor(draft.retrievalItems[0]!),
        context: "INITIAL",
        now: T0,
      }),
    ).toThrow(ConceptNotActiveError);
  });

  it("REQUIREMENT 7: DRAFT concepts cannot enter mastery", () => {
    // The only route into a mastery record is recordAttempt, which is gated.
    const learner = createLearnerState();
    expect(() =>
      recordAttempt(curriculum, learner, {
        conceptId: draft.id,
        itemId: draft.retrievalItems[0]!.id,
        answer: answerFor(draft.retrievalItems[0]!),
        context: "SPACED",
        now: T0,
      }),
    ).toThrow(ConceptNotActiveError);
    expect(learner.progress[draft.id]).toBeUndefined();

    // Even a hand-forged mastery record is excluded from lecture reporting.
    expect(conceptsForLecture(curriculum, DEMO_LECTURE_1).map((c) => c.id)).not.toContain(
      draft.id,
    );
  });

  it("REQUIREMENT 8: DRAFT concepts cannot enter scheduling", () => {
    const progress = createProgress(draft.id, newSchedule(T0));
    expect(() =>
      scheduleAfterAttempt(draft, progress, true, "SPACED", T0),
    ).toThrow(ConceptNotActiveError);
  });

  it("REQUIREMENT 9: DRAFT concepts cannot enter interleaving", () => {
    // Force a weak record onto a draft, as corrupted storage might.
    const learner: LearnerState = {
      ...createLearnerState(),
      progress: {
        [draft.id]: {
          ...createProgress(draft.id, newSchedule(T0)),
          mastery: "WEAK",
          totalAttempts: 4,
          everWrong: true,
        },
      },
    };
    const picked = selectInterleavedConcept(
      curriculum,
      learner,
      "lecture-inflammation",
      "chunk-inf-1",
      new Date(T0.getTime() + 30 * 86_400_000),
    );
    expect(picked?.id).not.toBe(draft.id);
  });

  it("REQUIREMENT 10: DRAFT concepts cannot enter the Today queue", () => {
    const learner: LearnerState = {
      ...createLearnerState(),
      progress: {
        [draft.id]: {
          ...createProgress(draft.id, newSchedule(T0)),
          mastery: "WEAK",
          totalAttempts: 4,
          everWrong: true,
        },
      },
    };
    const queue = buildTodayQueue(
      curriculum,
      learner,
      new Date(T0.getTime() + 30 * 86_400_000),
    );
    expect(queue.map((e) => e.concept.id)).not.toContain(draft.id);
  });

  it("DRAFT-only material cannot satisfy lecture unlock logic", () => {
    let learner = createLearnerState();
    const lecture = curriculum.course.lectures.find((l) => l.id === DEMO_LECTURE_1)!;

    // Read through every chunk without approving anything.
    for (const chunk of lecture.chunks) {
      learner = markChunkTaught(curriculum, learner, chunk.id);
    }
    expect(learner.completedLectureIds).not.toContain(DEMO_LECTURE_1);
    expect(isLectureUnlocked(curriculum, learner, "lecture-inflammation")).toBe(false);
  });

  it("the session reports that it is waiting on review, not that it is finished", () => {
    let learner = createLearnerState();
    // Finish the two authored chunks so the ingested chunk is next.
    for (const chunkId of ["chunk-ci-1", "chunk-ci-2"]) {
      learner = markChunkTaught(curriculum, learner, chunkId);
    }
    for (const concept of conceptsForLecture(curriculum, DEMO_LECTURE_1)) {
      const item = concept.retrievalItems[0]!;
      learner = recordAttempt(curriculum, learner, {
        conceptId: concept.id,
        itemId: item.id,
        answer: answerFor(item),
        context: "INITIAL",
        now: T0,
      }).learner;
    }

    const step = getNextStep(curriculum, learner, DEMO_LECTURE_1, T0);
    expect(step.kind).toBe("AWAITING_APPROVAL");
    if (step.kind === "AWAITING_APPROVAL") {
      expect(step.draftCount).toBeGreaterThan(0);
    }
  });
});

describe("the review workflow", () => {
  it("REQUIREMENT 11: editing a draft keeps it DRAFT", () => {
    const target = candidates[0]!;
    const edited = editConcept(baseOverrides, target.id, {
      title: "Corrected title",
      summary: "Corrected explanation.",
    });
    const curriculum = curriculumWith(edited);
    const concept = curriculum.concepts.find((c) => c.id === target.id)!;

    expect(concept.title).toBe("Corrected title");
    expect(concept.summary).toBe("Corrected explanation.");
    expect(concept.status).toBe("DRAFT");
    expect(edited.statusById[target.id]).toBeUndefined();
  });

  it("an edit does not disturb source provenance", () => {
    const target = candidates[0]!;
    const edited = editConcept(baseOverrides, target.id, { title: "Renamed" });
    const concept = curriculumWith(edited).concepts.find((c) => c.id === target.id)!;
    expect(concept.source).toEqual(target.source);
    expect(concept.source.excerpt).toBe(target.source.excerpt);
  });

  it("REQUIREMENT 12: approving changes DRAFT to ACTIVE", () => {
    const target = candidates[0]!;
    const approved = setConceptStatus(baseOverrides, target.id, "ACTIVE");
    const concept = curriculumWith(approved).concepts.find((c) => c.id === target.id)!;
    expect(concept.status).toBe("ACTIVE");
    expect(() => assertActive(concept, "teaching")).not.toThrow();
  });

  it("an edit made before approval survives approval", () => {
    const target = candidates[0]!;
    let overrides = editConcept(baseOverrides, target.id, { title: "Edited then approved" });
    overrides = setConceptStatus(overrides, target.id, "ACTIVE");
    const concept = curriculumWith(overrides).concepts.find((c) => c.id === target.id)!;
    expect(concept.title).toBe("Edited then approved");
    expect(concept.status).toBe("ACTIVE");
  });

  it("REQUIREMENT 13: discarding keeps a concept out of learning", () => {
    const target = candidates[0]!;
    const discarded = setConceptStatus(baseOverrides, target.id, "DISCARDED");
    const curriculum = curriculumWith(discarded);
    const concept = curriculum.concepts.find((c) => c.id === target.id)!;

    expect(concept.status).toBe("DISCARDED");
    expect(() => assertActive(concept, "teaching")).toThrow(ConceptNotActiveError);
    expect(conceptsForLecture(curriculum, DEMO_LECTURE_1).map((c) => c.id)).not.toContain(
      target.id,
    );
    expect(() =>
      recordAttempt(curriculum, createLearnerState(), {
        conceptId: target.id,
        itemId: target.retrievalItems[0]!.id,
        answer: "anything",
        context: "INITIAL",
        now: T0,
      }),
    ).toThrow(ConceptNotActiveError);
  });

  it("bulk approval promotes every selected candidate", () => {
    const ids = candidates.slice(0, 5).map((c) => c.id);
    const approved = setConceptStatuses(baseOverrides, ids, "ACTIVE");
    const curriculum = curriculumWith(approved);
    for (const id of ids) {
      expect(curriculum.concepts.find((c) => c.id === id)!.status).toBe("ACTIVE");
    }
  });
});

describe("REQUIREMENT 14: approved concepts work with the existing tutor", () => {
  it("an approved candidate is taught, tested and scheduled by the Milestone 1 engine", () => {
    const approved = setConceptStatuses(
      baseOverrides,
      candidates.map((c) => c.id),
      "ACTIVE",
    );
    const curriculum = curriculumWith(approved);
    let learner = createLearnerState();

    // Work the whole lecture, authored chunks first, then the ingested ones.
    let ingestedTaught = false;
    let ingestedAnswered = 0;

    for (let i = 0; i < 80; i++) {
      const step = getNextStep(curriculum, learner, DEMO_LECTURE_1, T0);
      if (step.kind === "LECTURE_COMPLETE") break;
      if (step.kind === "AWAITING_APPROVAL") {
        throw new Error("nothing should be awaiting approval after bulk approve");
      }
      if (step.kind === "TEACH") {
        if (step.chunk.documentId === doc.id) {
          ingestedTaught = true;
          // Ingested concepts really do reach the teaching step.
          expect(step.concepts.length).toBeGreaterThan(0);
          expect(step.pages.length).toBeGreaterThan(0);
        }
        learner = markChunkTaught(curriculum, learner, step.chunk.id);
        continue;
      }
      const result = recordAttempt(curriculum, learner, {
        conceptId: step.concept.id,
        itemId: step.item.id,
        answer: answerFor(step.item),
        context: step.context,
        chunkId: step.chunk.id,
        now: T0,
      });
      if (candidates.some((c) => c.id === step.concept.id)) {
        expect(result.grade.correct, `${step.concept.id} / ${step.item.id}`).toBe(true);
        ingestedAnswered++;
      }
      learner = result.learner;
    }

    expect(ingestedTaught).toBe(true);
    expect(ingestedAnswered).toBeGreaterThan(0);

    // Mastery and FSRS scheduling now exist for ingested concepts.
    const sample = learner.progress[candidates[0]!.id];
    expect(sample).toBeDefined();
    expect(sample!.mastery).toBe("LEARNING");
    expect(sample!.schedule.reps).toBeGreaterThan(0);

    // And the lecture genuinely completes, unlocking the next one.
    expect(learner.completedLectureIds).toContain(DEMO_LECTURE_1);
    expect(isLectureUnlocked(curriculum, learner, "lecture-inflammation")).toBe(true);
  });

  it("a wrong answer on an ingested concept marks it WEAK like any other", () => {
    const approved = setConceptStatuses(
      baseOverrides,
      candidates.map((c) => c.id),
      "ACTIVE",
    );
    const curriculum = curriculumWith(approved);
    const target = curriculum.concepts.find((c) => c.id === candidates[0]!.id)!;

    const result = recordAttempt(curriculum, createLearnerState(), {
      conceptId: target.id,
      itemId: target.retrievalItems[0]!.id,
      answer: "I have no idea",
      context: "INITIAL",
      now: T0,
    });
    expect(result.grade.correct).toBe(false);
    expect(result.progress.mastery).toBe("WEAK");

    // And immediate remediation still does not clear it.
    const remediated = applyRetrievalToMastery(result.progress, {
      correct: true,
      context: "IMMEDIATE_REMEDIATION",
      at: T0.toISOString(),
    });
    expect(remediated.mastery).toBe("WEAK");
  });
});

describe("REQUIREMENT 15: state survives reload", () => {
  beforeEach(() => {
    installFakeStorage();
  });

  it("ingested documents, drafts, edits and approvals all persist", () => {
    let overrides = editConcept(baseOverrides, candidates[1]!.id, {
      title: "Edited before reload",
    });
    overrides = setConceptStatus(overrides, candidates[0]!.id, "ACTIVE");
    overrides = setConceptStatus(overrides, candidates[2]!.id, "DISCARDED");

    new LocalStorageCurriculumRepository().save(overrides);

    // "Reload": a fresh repository reading the same storage.
    const reloaded = new LocalStorageCurriculumRepository().load();
    expect(reloaded).not.toBeNull();

    const curriculum = curriculumWith(reloaded!);
    expect(curriculum.concepts.find((c) => c.id === candidates[0]!.id)!.status).toBe("ACTIVE");
    expect(curriculum.concepts.find((c) => c.id === candidates[1]!.id)!.title).toBe(
      "Edited before reload",
    );
    expect(curriculum.concepts.find((c) => c.id === candidates[1]!.id)!.status).toBe("DRAFT");
    expect(curriculum.concepts.find((c) => c.id === candidates[2]!.id)!.status).toBe(
      "DISCARDED",
    );

    const lecture = curriculum.course.lectures.find((l) => l.id === DEMO_LECTURE_1)!;
    expect(lecture.documents.some((d) => d.id === doc.id)).toBe(true);
  });

  it("page text and page numbers survive the round trip", () => {
    new LocalStorageCurriculumRepository().save(baseOverrides);
    const reloaded = new LocalStorageCurriculumRepository().load()!;
    const stored = reloaded.ingested[0]!.document;
    expect(stored.pages.map((p) => p.number)).toEqual([1, 2, 3, 4]);
    expect(stored.pages[1]!.text).toContain("ATP depletion");
  });

  it("learner progress on ingested concepts survives reload", () => {
    const approved = setConceptStatuses(
      baseOverrides,
      candidates.map((c) => c.id),
      "ACTIVE",
    );
    const curriculum = curriculumWith(approved);
    const target = curriculum.concepts.find((c) => c.id === candidates[0]!.id)!;

    const { learner } = recordAttempt(curriculum, createLearnerState(), {
      conceptId: target.id,
      itemId: target.retrievalItems[0]!.id,
      answer: answerFor(target.retrievalItems[0]!),
      context: "INITIAL",
      now: T0,
    });

    new LocalStorageLearnerRepository().save(learner);
    const reloaded = new LocalStorageLearnerRepository().load()!;
    expect(reloaded.progress[target.id]?.totalAttempts).toBe(1);
    expect(reloaded.progress[target.id]?.mastery).toBe("LEARNING");
  });

  it("a Milestone 1 store is migrated without losing approvals", () => {
    const store = installFakeStorage();
    store.set(
      CURRICULUM_STORAGE_KEY,
      JSON.stringify({ version: 1, statusById: { "c-draft-lysosomal": "ACTIVE" } }),
    );
    const migrated = new LocalStorageCurriculumRepository().load();
    expect(migrated).not.toBeNull();
    expect(migrated!.version).toBe(2);
    expect(migrated!.statusById["c-draft-lysosomal"]).toBe("ACTIVE");
    expect(migrated!.ingested).toEqual([]);
    expect(migrated!.concepts).toEqual([]);
  });

  it("rejects state written by a future version", () => {
    expect(migrateOverrides({ version: 99, statusById: {} })).toBeNull();
  });

  it("rejects structurally invalid state", () => {
    expect(migrateOverrides({ version: 2 })).toBeNull();
    expect(migrateOverrides(null)).toBeNull();
    expect(migrateOverrides("nope")).toBeNull();
  });
});
