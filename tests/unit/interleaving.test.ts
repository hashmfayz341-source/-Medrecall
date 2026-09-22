import { describe, expect, it } from "vitest";
import {
  DEMO_LECTURE_1,
  DEMO_LECTURE_2,
  pathologyCurriculum,
} from "@/lib/content/pathology";
import {
  createLearnerState,
  getNextStep,
  selectInterleavedConcept,
} from "@/lib/engine/tutor";
import { buildTodayQueue, weakConcepts } from "@/lib/engine/priority";
import { ANSWERS, T0, WRONG, daysLater } from "./helpers";
import { driveLecture, type AnswerFn } from "./driver";

/** Fail ATP depletion on its first, unaided attempt only. */
const failAtpOnce: AnswerFn = (step) => {
  if (step.kind === "RETRIEVE" && step.concept.id === "c-atp-depletion") {
    return WRONG;
  }
  return ANSWERS[step.concept.id] ?? WRONG;
};

function lectureOneWithWeakAtp() {
  return driveLecture(createLearnerState(), DEMO_LECTURE_1, T0, failAtpOnce).learner;
}

describe("cross-lecture interleaving", () => {
  it("nothing is interleaved during the first lecture — there is no earlier material", () => {
    const step = getNextStep(
      pathologyCurriculum,
      createLearnerState(),
      DEMO_LECTURE_1,
      T0,
    );
    expect(step.kind).toBe("TEACH");
  });

  it("a weak Lecture 1 concept is selected for injection into Lecture 2", () => {
    const learner = lectureOneWithWeakAtp();
    expect(learner.progress["c-atp-depletion"]?.mastery).toBe("WEAK");

    const picked = selectInterleavedConcept(
      pathologyCurriculum,
      learner,
      DEMO_LECTURE_2,
      "chunk-inf-1",
      T0,
    );
    expect(picked?.id).toBe("c-atp-depletion");
  });

  it("the weak concept is actually injected as the first step of Lecture 2", () => {
    const learner = lectureOneWithWeakAtp();
    const step = getNextStep(pathologyCurriculum, learner, DEMO_LECTURE_2, T0);

    expect(step.kind).toBe("INTERLEAVE");
    if (step.kind === "INTERLEAVE") {
      expect(step.concept.id).toBe("c-atp-depletion");
      expect(step.concept.lectureId).toBe(DEMO_LECTURE_1);
      expect(step.fromLecture.title).toBe("Cell Injury");
      expect(step.context).toBe("INTERLEAVED");
    }
  });

  it("the injected question is a DIFFERENT form from the one already seen", () => {
    const learner = lectureOneWithWeakAtp();
    const step = getNextStep(pathologyCurriculum, learner, DEMO_LECTURE_2, T0);
    if (step.kind !== "INTERLEAVE") throw new Error("expected INTERLEAVE");
    // Initial attempt used c-atp-1, remediation used c-atp-2.
    expect(["c-atp-1", "c-atp-2"]).not.toContain(step.item.id);
    expect(step.item.conceptId).toBe("c-atp-depletion");
  });

  it("a chunk is interrupted at most once", () => {
    const learner = lectureOneWithWeakAtp();
    const { log } = driveLecture(learner, DEMO_LECTURE_2, T0);
    const perChunkInjections = log.filter((l) => l.kind === "INTERLEAVE").length;
    // Two chunks in Lecture 2, so at most two injections in the whole lecture.
    expect(perChunkInjections).toBeLessThanOrEqual(2);
  });

  it("once answered, the same concept is not re-injected into the same chunk", () => {
    const learner = lectureOneWithWeakAtp();
    const { log } = driveLecture(learner, DEMO_LECTURE_2, T0);
    const injected = log
      .filter((l) => l.kind === "INTERLEAVE")
      .map((l) => l.conceptId);
    expect(new Set(injected).size).toBe(injected.length);
  });

  it("learning state is retained across lectures", () => {
    const learner = lectureOneWithWeakAtp();
    const { learner: after } = driveLecture(learner, DEMO_LECTURE_2, T0);
    // Lecture 1 concepts still carry their history after Lecture 2 is worked.
    expect(after.progress["c-hypoxia"]?.totalAttempts).toBeGreaterThan(0);
    expect(after.progress["c-atp-depletion"]?.everWrong).toBe(true);
  });
});

describe("today queue priority", () => {
  it("weak concepts outrank merely-due ones", () => {
    const learner = lectureOneWithWeakAtp();
    const queue = buildTodayQueue(pathologyCurriculum, learner, daysLater(30));
    expect(queue.length).toBeGreaterThan(0);
    expect(queue[0]!.concept.id).toBe("c-atp-depletion");
  });

  it("the weak list surfaces exactly the WEAK concepts", () => {
    const learner = lectureOneWithWeakAtp();
    const weak = weakConcepts(pathologyCurriculum, learner);
    expect(weak.map((w) => w.concept.id)).toEqual(["c-atp-depletion"]);
  });

  it("an untouched concept is not in the queue", () => {
    const queue = buildTodayQueue(
      pathologyCurriculum,
      createLearnerState(),
      daysLater(30),
    );
    expect(queue).toHaveLength(0);
  });

  it("prerequisites of current material are boosted", () => {
    const learner = lectureOneWithWeakAtp();
    const withoutContext = buildTodayQueue(
      pathologyCurriculum,
      learner,
      daysLater(30),
      [],
    );
    const withContext = buildTodayQueue(
      pathologyCurriculum,
      learner,
      daysLater(30),
      ["c-na-k-atpase"], // its prerequisite is c-atp-depletion
    );
    const before = withoutContext.find((e) => e.concept.id === "c-atp-depletion")!;
    const after = withContext.find((e) => e.concept.id === "c-atp-depletion")!;
    expect(after.score).toBeGreaterThan(before.score);
  });
});
