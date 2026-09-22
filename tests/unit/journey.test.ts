import { describe, expect, it } from "vitest";
import {
  DEMO_LECTURE_1,
  DEMO_LECTURE_2,
  pathologyCurriculum,
} from "@/lib/content/pathology";
import {
  createLearnerState,
  getNextStep,
  isLectureUnlocked,
  recordAttempt,
} from "@/lib/engine/tutor";
import { weakConcepts } from "@/lib/engine/priority";
import { LocalStorageLearnerRepository } from "@/lib/persistence/localStorage";
import { ANSWERS, CORRECT_ATP, T0, WRONG, daysLater } from "./helpers";
import { driveLecture, type AnswerFn } from "./driver";
import type { LearnerState } from "@/lib/domain/types";

const ATP = "c-atp-depletion";

function installFakeStorage() {
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
}

/** Simulate closing and reopening the browser. */
function reload(learner: LearnerState): LearnerState {
  installFakeStorage();
  const repo = new LocalStorageLearnerRepository();
  repo.save(learner);
  const restored = new LocalStorageLearnerRepository().load();
  expect(restored).not.toBeNull();
  return restored!;
}

const failAtpOnce: AnswerFn = (step) =>
  step.kind === "RETRIEVE" && step.concept.id === ATP
    ? WRONG
    : (ANSWERS[step.concept.id] ?? WRONG);

describe("the Pathology demo journey", () => {
  it("runs the complete required journey end to end", () => {
    /* 1. Open Pathology */
    let learner = createLearnerState();
    expect(pathologyCurriculum.course.title).toBe("Pathology");
    expect(pathologyCurriculum.course.lectures.map((l) => l.title)).toEqual([
      "Cell Injury",
      "Inflammation",
    ]);

    /* 2. Start Cell Injury — it is unlocked, Inflammation is not */
    expect(isLectureUnlocked(pathologyCurriculum, learner, DEMO_LECTURE_1)).toBe(true);
    expect(isLectureUnlocked(pathologyCurriculum, learner, DEMO_LECTURE_2)).toBe(false);

    /* 3. Learn in chunks: the first step is teaching, not a question */
    const opening = getNextStep(pathologyCurriculum, learner, DEMO_LECTURE_1, T0);
    expect(opening.kind).toBe("TEACH");
    if (opening.kind === "TEACH") {
      expect(opening.pages.length).toBeGreaterThanOrEqual(2);
      expect(opening.pages.length).toBeLessThanOrEqual(5);
    }

    /* 4-6. Work the lecture, failing ATP depletion on its first attempt */
    const firstPass = driveLecture(learner, DEMO_LECTURE_1, T0, failAtpOnce);
    learner = firstPass.learner;

    const atpEvents = firstPass.log.filter((l) => l.conceptId === ATP);
    const initialAttempt = atpEvents.find((l) => l.kind === "RETRIEVE")!;
    expect(initialAttempt.correct).toBe(false);
    expect(initialAttempt.mastery).toBe("WEAK");

    /* 7. It was re-taught immediately */
    const remediation = atpEvents.find((l) => l.kind === "REMEDIATE");
    expect(remediation, "ATP depletion should have been re-taught").toBeDefined();
    expect(remediation!.correct).toBe(true);

    /* 8. Immediate remediation success does NOT clear the weakness */
    expect(remediation!.mastery).toBe("WEAK");
    expect(learner.progress[ATP]?.mastery).toBe("WEAK");
    expect(learner.progress[ATP]?.immediateRemediationPassed).toBe(true);
    expect(weakConcepts(pathologyCurriculum, learner).map((w) => w.concept.id)).toEqual([
      ATP,
    ]);

    /* 9. Lecture 1 is complete despite the lingering weakness */
    expect(learner.completedLectureIds).toContain(DEMO_LECTURE_1);

    /* 10. Lecture 2 is unlocked */
    expect(isLectureUnlocked(pathologyCurriculum, learner, DEMO_LECTURE_2)).toBe(true);

    /* 11. Reload the browser and retain progress */
    learner = reload(learner);
    expect(learner.completedLectureIds).toContain(DEMO_LECTURE_1);
    expect(learner.progress[ATP]?.mastery).toBe("WEAK");

    /* 12-13. Begin Lecture 2: the weak ATP concept is injected first */
    const later = daysLater(2);
    const l2Opening = getNextStep(pathologyCurriculum, learner, DEMO_LECTURE_2, later);
    expect(l2Opening.kind).toBe("INTERLEAVE");
    if (l2Opening.kind !== "INTERLEAVE") throw new Error("expected INTERLEAVE");
    expect(l2Opening.concept.id).toBe(ATP);
    expect(l2Opening.fromLecture.id).toBe(DEMO_LECTURE_1);

    /* 14-15. Answering correctly later improves mastery */
    const injected = recordAttempt(pathologyCurriculum, learner, {
      conceptId: ATP,
      itemId: l2Opening.item.id,
      answer: CORRECT_ATP,
      context: "INTERLEAVED",
      chunkId: l2Opening.chunk.id,
      now: later,
    });
    learner = injected.learner;

    expect(injected.grade.correct).toBe(true);
    expect(injected.progress.mastery).toBe("LEARNING");
    expect(injected.progress.mastery).not.toBe("WEAK");
    expect(weakConcepts(pathologyCurriculum, learner)).toHaveLength(0);

    /* The lecture then proceeds to its own material */
    const afterInjection = getNextStep(
      pathologyCurriculum,
      learner,
      DEMO_LECTURE_2,
      later,
    );
    expect(afterInjection.kind).toBe("TEACH");

    /* 16. Reload again and retain everything */
    learner = reload(learner);
    expect(learner.progress[ATP]?.mastery).toBe("LEARNING");
    expect(learner.progress[ATP]?.everWrong).toBe(true);
    expect(learner.completedLectureIds).toContain(DEMO_LECTURE_1);

    /* Finish Lecture 2 for good measure */
    const second = driveLecture(learner, DEMO_LECTURE_2, later);
    expect(second.learner.completedLectureIds).toContain(DEMO_LECTURE_2);
  });

  it("mastery keeps climbing with further spaced successes", () => {
    let learner = driveLecture(
      createLearnerState(),
      DEMO_LECTURE_1,
      T0,
      failAtpOnce,
    ).learner;

    const ladder: string[] = [];
    for (let day = 2; day <= 4; day++) {
      const result = recordAttempt(pathologyCurriculum, learner, {
        conceptId: ATP,
        itemId: "c-atp-3",
        answer: CORRECT_ATP,
        context: "SPACED",
        now: daysLater(day),
      });
      learner = result.learner;
      ladder.push(result.progress.mastery);
    }
    expect(ladder).toEqual(["LEARNING", "STABLE", "STRONG"]);
  });

  it("failing again after recovery sends the concept straight back to WEAK", () => {
    let learner = driveLecture(
      createLearnerState(),
      DEMO_LECTURE_1,
      T0,
      failAtpOnce,
    ).learner;

    learner = recordAttempt(pathologyCurriculum, learner, {
      conceptId: ATP,
      itemId: "c-atp-3",
      answer: CORRECT_ATP,
      context: "SPACED",
      now: daysLater(2),
    }).learner;
    expect(learner.progress[ATP]?.mastery).toBe("LEARNING");

    const lapse = recordAttempt(pathologyCurriculum, learner, {
      conceptId: ATP,
      itemId: "c-atp-1",
      answer: WRONG,
      context: "SPACED",
      now: daysLater(9),
    });
    expect(lapse.progress.mastery).toBe("WEAK");
    expect(lapse.progress.consecutiveSpacedSuccesses).toBe(0);
  });

  it("a learner who answers everything correctly never sees remediation", () => {
    const { log } = driveLecture(createLearnerState(), DEMO_LECTURE_1, T0);
    expect(log.filter((l) => l.kind === "REMEDIATE")).toHaveLength(0);
    expect(log.at(-1)?.kind).toBe("LECTURE_COMPLETE");
  });

  it("the whole journey is deterministic: identical runs, identical state", () => {
    const runOne = driveLecture(createLearnerState(), DEMO_LECTURE_1, T0, failAtpOnce);
    const runTwo = driveLecture(createLearnerState(), DEMO_LECTURE_1, T0, failAtpOnce);
    expect(runOne.log).toEqual(runTwo.log);
    expect(runOne.learner).toEqual(runTwo.learner);
  });
});
