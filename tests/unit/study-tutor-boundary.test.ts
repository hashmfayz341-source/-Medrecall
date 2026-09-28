import { describe, expect, it } from "vitest";
import { pathologyCurriculum } from "@/lib/content/pathology";
import { recordCardRating, studyCardsForLecture } from "@/lib/engine/study";
import {
  createLearnerState,
  getConcept,
  getLecture,
  getNextStep,
  isLectureUnlocked,
  markChunkTaught,
  pickItem,
  recordAttempt,
  reconcile,
} from "@/lib/engine/tutor";
import { applyOverrides, createOverrides, setConceptStatus } from "@/lib/domain/curriculum";
import type { Curriculum, LearnerState, SelfRating } from "@/lib/domain/types";
import { ANSWERS, WRONG } from "./helpers";
import { driveLecture } from "./driver";

/**
 * Card Study and the Tutor share concept MASTERY, but evidence that a Tutor
 * retrieval happened comes only from the Tutor path (a concept-level FSRS
 * review, `schedule.reps > 0`). Study ratings must never satisfy a Tutor
 * retrieval, complete a chunk or lecture, rotate Tutor items, or hijack the
 * Tutor with remediation for material the Tutor has not legitimately covered.
 */

const L1 = "lecture-cell-injury";
const L2 = "lecture-inflammation";
const T0 = new Date("2026-06-01T09:00:00.000Z");
const at = (m: number) => new Date(T0.getTime() + m * 60_000);

function studyAll(curriculum: Curriculum, learner: LearnerState, lectureId: string, rating: SelfRating, now: Date) {
  for (const { concept, item } of studyCardsForLecture(curriculum, lectureId)) {
    learner = recordCardRating(curriculum, learner, { conceptId: concept.id, itemId: item.id, rating, now }).learner;
  }
  return learner;
}

describe("H1: Study never satisfies Tutor retrieval", () => {
  for (const rating of ["GOOD", "EASY"] as const) {
    it(`A (${rating}): taught chunk + Study ratings → Tutor still asks RETRIEVE`, () => {
      const lecture = getLecture(pathologyCurriculum, L1);
      const chunk = [...lecture.chunks].sort((a, b) => a.order - b.order)[0]!;
      let learner = markChunkTaught(pathologyCurriculum, createLearnerState(), chunk.id);
      learner = studyAll(pathologyCurriculum, learner, L1, rating, T0);
      for (const id of chunk.conceptIds) {
        const p = learner.progress[id];
        if (p) expect(p.totalAttempts).toBeGreaterThan(0);
      }
      const step = getNextStep(pathologyCurriculum, learner, L1, at(1));
      expect(step.kind).toBe("RETRIEVE");
      if (step.kind === "RETRIEVE") expect(step.chunk.id).toBe(chunk.id);
      expect(learner.completedChunkIds).not.toContain(chunk.id);
    });
  }

  it("B: every chunk taught + every card studied → Lecture 1 NOT complete, Lecture 2 NOT unlocked", () => {
    let learner = createLearnerState();
    for (const chunk of getLecture(pathologyCurriculum, L1).chunks) {
      learner = markChunkTaught(pathologyCurriculum, learner, chunk.id);
    }
    for (const rating of ["EASY", "GOOD", "EASY"] as const) {
      learner = studyAll(pathologyCurriculum, learner, L1, rating, at(60 * 24 * 30));
    }
    learner = reconcile(pathologyCurriculum, learner);
    expect(learner.completedChunkIds).toEqual([]);
    expect(learner.completedLectureIds).not.toContain(L1);
    expect(isLectureUnlocked(pathologyCurriculum, learner, L2)).toBe(false);
    expect(getNextStep(pathologyCurriculum, learner, L1, at(60 * 24 * 31)).kind).toBe("RETRIEVE");
  });

  it("C: after real Tutor retrievals, progression and unlocking work exactly as a Tutor-only learner", () => {
    const studied = studyAll(pathologyCurriculum, createLearnerState(), L1, "EASY", T0);
    const withStudy = driveLecture(studied, L1, at(60));
    const tutorOnly = driveLecture(createLearnerState(), L1, at(60));
    // Same Tutor step sequence…
    expect(withStudy.log.map((l) => [l.kind, l.conceptId, l.itemId])).toEqual(
      tutorOnly.log.map((l) => [l.kind, l.conceptId, l.itemId]),
    );
    // …and the same completion and unlock outcome.
    expect(withStudy.learner.completedLectureIds).toContain(L1);
    expect(isLectureUnlocked(pathologyCurriculum, withStudy.learner, L2)).toBe(true);
    expect(withStudy.learner.completedChunkIds.sort()).toEqual(tutorOnly.learner.completedChunkIds.sort());
    for (const id of Object.keys(tutorOnly.learner.progress)) {
      expect(withStudy.learner.progress[id]!.schedule.reps).toBe(tutorOnly.learner.progress[id]!.schedule.reps);
    }
  });

  it("D: Study ratings do not change which Tutor item is selected", () => {
    const concept = getConcept(pathologyCurriculum, "c-atp-depletion");
    const item = concept.retrievalItems[0]!;
    const tutored = recordAttempt(pathologyCurriculum, createLearnerState(), {
      conceptId: concept.id, itemId: item.id, answer: ANSWERS[concept.id]!, context: "INITIAL", now: T0,
    }).learner;
    let studied = tutored;
    for (const [i, rating] of (["GOOD", "HARD", "EASY", "GOOD"] as const).entries()) {
      const card = concept.retrievalItems[i % concept.retrievalItems.length]!;
      studied = recordCardRating(pathologyCurriculum, studied, { conceptId: concept.id, itemId: card.id, rating, now: at(10 + i) }).learner;
    }
    expect(studied.progress[concept.id]!.totalAttempts).toBeGreaterThan(tutored.progress[concept.id]!.totalAttempts);
    for (const ctx of ["INITIAL", "IMMEDIATE_REMEDIATION", "SPACED", "INTERLEAVED"] as const) {
      expect(pickItem(concept, ctx, studied.progress[concept.id]).id, ctx).toBe(
        pickItem(concept, ctx, tutored.progress[concept.id]).id,
      );
    }
  });
});

describe("H2: Study failures never hijack the Tutor", () => {
  it("1: Study AGAIN on a locked Lecture 2 concept does not interrupt Tutor Lecture 1", () => {
    const cardinal = getConcept(pathologyCurriculum, "c-cardinal-signs");
    let learner = recordCardRating(pathologyCurriculum, createLearnerState(), {
      conceptId: cardinal.id, itemId: cardinal.retrievalItems[0]!.id, rating: "AGAIN", now: T0,
    }).learner;
    expect(learner.progress[cardinal.id]!.mastery).toBe("WEAK");
    expect(isLectureUnlocked(pathologyCurriculum, learner, L2)).toBe(false);
    let step = getNextStep(pathologyCurriculum, learner, L1, at(1));
    expect(step.kind).toBe("TEACH");
    learner = markChunkTaught(pathologyCurriculum, learner, step.kind === "TEACH" ? step.chunk.id : "");
    step = getNextStep(pathologyCurriculum, learner, L1, at(2));
    expect(step.kind).toBe("RETRIEVE");
    if (step.kind === "RETRIEVE") expect(step.concept.lectureId).toBe(L1);
  });

  it("2: Study AGAIN on a current-lecture concept before the Tutor taught it → TEACH, then RETRIEVE (no REMEDIATE)", () => {
    const first = getLecture(pathologyCurriculum, L1).chunks[0]!;
    const conceptId = first.conceptIds[0]!;
    const concept = getConcept(pathologyCurriculum, conceptId);
    let learner = recordCardRating(pathologyCurriculum, createLearnerState(), {
      conceptId, itemId: concept.retrievalItems[0]!.id, rating: "AGAIN", now: T0,
    }).learner;
    expect(learner.progress[conceptId]!.mastery).toBe("WEAK"); // shared mastery
    const teach = getNextStep(pathologyCurriculum, learner, L1, at(1));
    expect(teach.kind).toBe("TEACH");
    learner = markChunkTaught(pathologyCurriculum, learner, first.id);
    const retrieve = getNextStep(pathologyCurriculum, learner, L1, at(2));
    expect(retrieve.kind).toBe("RETRIEVE");
    if (retrieve.kind === "RETRIEVE") expect(retrieve.concept.id).toBe(conceptId);
  });

  it("3: a real Tutor INITIAL failure still gets immediate REMEDIATE", () => {
    const first = getLecture(pathologyCurriculum, L1).chunks[0]!;
    let learner = markChunkTaught(pathologyCurriculum, createLearnerState(), first.id);
    const step = getNextStep(pathologyCurriculum, learner, L1, T0);
    expect(step.kind).toBe("RETRIEVE");
    if (step.kind !== "RETRIEVE") return;
    learner = recordAttempt(pathologyCurriculum, learner, {
      conceptId: step.concept.id, itemId: step.item.id, answer: WRONG, context: "INITIAL", chunkId: step.chunk.id, now: T0,
    }).learner;
    const next = getNextStep(pathologyCurriculum, learner, L1, at(1));
    expect(next.kind).toBe("REMEDIATE");
    if (next.kind === "REMEDIATE") expect(next.concept.id).toBe(step.concept.id);
  });

  it("4: a real Tutor INTERLEAVED failure from an earlier lecture still gets immediate REMEDIATE", () => {
    const failAtp = (s: { concept: { id: string } }, log: { conceptId?: string }[]) =>
      s.concept.id === "c-atp-depletion" && !log.some((l) => l.conceptId === "c-atp-depletion") ? WRONG : (ANSWERS[s.concept.id] ?? WRONG);
    let learner = driveLecture(createLearnerState(), L1, T0, failAtp).learner;
    const later = at(60 * 24 * 2);
    const step = getNextStep(pathologyCurriculum, learner, L2, later);
    expect(step.kind).toBe("INTERLEAVE");
    if (step.kind !== "INTERLEAVE") return;
    learner = recordAttempt(pathologyCurriculum, learner, {
      conceptId: step.concept.id, itemId: step.item.id, answer: WRONG, context: "INTERLEAVED", chunkId: step.chunk.id, now: later,
    }).learner;
    const next = getNextStep(pathologyCurriculum, learner, L2, later);
    expect(next.kind).toBe("REMEDIATE");
    if (next.kind === "REMEDIATE") expect(next.concept.id).toBe(step.concept.id);
  });

  it("5 (defined): Study AGAIN on a concept the Tutor has legitimately covered → Tutor remediates it (shared WEAK, not yet re-taught)", () => {
    let learner = driveLecture(createLearnerState(), L1, T0).learner; // all L1 concepts Tutor-attempted, none WEAK
    const atp = getConcept(pathologyCurriculum, "c-atp-depletion");
    learner = recordCardRating(pathologyCurriculum, learner, {
      conceptId: atp.id, itemId: atp.retrievalItems[0]!.id, rating: "AGAIN", now: at(60 * 24),
    }).learner;
    expect(learner.progress[atp.id]!.mastery).toBe("WEAK");
    expect(learner.completedLectureIds).toContain(L1); // completion is not revoked
    const step = getNextStep(pathologyCurriculum, learner, L2, at(60 * 24 + 1));
    expect(step.kind).toBe("REMEDIATE");
    if (step.kind === "REMEDIATE") expect(step.concept.id).toBe(atp.id);
  });

  it("a later lecture's pending Tutor remediation never interrupts an earlier lecture", () => {
    // Tutor-complete Lecture 1, then fail a Lecture 2 concept in the Tutor.
    let learner = driveLecture(createLearnerState(), L1, T0).learner;
    const l2 = getLecture(pathologyCurriculum, L2);
    learner = markChunkTaught(pathologyCurriculum, learner, l2.chunks[0]!.id);
    const retrieve = getNextStep(pathologyCurriculum, learner, L2, at(10));
    expect(retrieve.kind).toBe("RETRIEVE");
    if (retrieve.kind !== "RETRIEVE") return;
    learner = recordAttempt(pathologyCurriculum, learner, {
      conceptId: retrieve.concept.id, itemId: retrieve.item.id, answer: WRONG, context: "INITIAL", chunkId: retrieve.chunk.id, now: at(10),
    }).learner;
    // Newly approved Lecture 1 material reopens Lecture 1.
    const reopened = applyOverrides(pathologyCurriculum, setConceptStatus(createOverrides(), "c-draft-lysosomal", "ACTIVE"));
    const step = getNextStep(reopened, learner, L1, at(11));
    expect(step.kind).not.toBe("REMEDIATE");
    expect(step.kind === "RETRIEVE" || step.kind === "TEACH").toBe(true);
  });
});
