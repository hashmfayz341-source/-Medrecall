import { describe, expect, it } from "vitest";
import {
  applyRetrievalToMastery,
  createProgress,
  masteryForStreak,
} from "@/lib/domain/mastery";
import { newSchedule, ratingFor, scheduleAfterAttempt } from "@/lib/engine/scheduler";
import { getConcept } from "@/lib/engine/tutor";
import { pathologyCurriculum } from "@/lib/content/pathology";
import { Rating } from "ts-fsrs";
import { ANSWERS, T0, answer, daysLater, fresh } from "./helpers";

const at = T0.toISOString();

function p() {
  return createProgress("c-atp-depletion", newSchedule(T0));
}

describe("mastery transitions", () => {
  it("a new concept starts NEW with no attempts", () => {
    expect(p().mastery).toBe("NEW");
    expect(p().everWrong).toBe(false);
  });

  it("a wrong retrieval marks the concept WEAK", () => {
    const after = applyRetrievalToMastery(p(), {
      correct: false,
      context: "INITIAL",
      at,
    });
    expect(after.mastery).toBe("WEAK");
    expect(after.everWrong).toBe(true);
    expect(after.consecutiveSpacedSuccesses).toBe(0);
  });

  it("IMMEDIATE remediation success does NOT clear WEAK", () => {
    const wrong = applyRetrievalToMastery(p(), {
      correct: false,
      context: "INITIAL",
      at,
    });
    const remediated = applyRetrievalToMastery(wrong, {
      correct: true,
      context: "IMMEDIATE_REMEDIATION",
      at,
    });

    expect(remediated.mastery).toBe("WEAK");
    expect(remediated.immediateRemediationPassed).toBe(true);
    expect(remediated.consecutiveSpacedSuccesses).toBe(0);
  });

  it("repeated immediate remediation still does not clear WEAK", () => {
    let progress = applyRetrievalToMastery(p(), {
      correct: false,
      context: "INITIAL",
      at,
    });
    for (let i = 0; i < 5; i++) {
      progress = applyRetrievalToMastery(progress, {
        correct: true,
        context: "IMMEDIATE_REMEDIATION",
        at,
      });
    }
    expect(progress.mastery).toBe("WEAK");
  });

  it("a later SPACED success clears WEAK and promotes to LEARNING", () => {
    const wrong = applyRetrievalToMastery(p(), {
      correct: false,
      context: "INITIAL",
      at,
    });
    const remediated = applyRetrievalToMastery(wrong, {
      correct: true,
      context: "IMMEDIATE_REMEDIATION",
      at,
    });
    const spaced = applyRetrievalToMastery(remediated, {
      correct: true,
      context: "SPACED",
      at,
    });

    expect(spaced.mastery).toBe("LEARNING");
    expect(spaced.consecutiveSpacedSuccesses).toBe(1);
  });

  it("an INTERLEAVED success also clears WEAK", () => {
    const wrong = applyRetrievalToMastery(p(), {
      correct: false,
      context: "INITIAL",
      at,
    });
    const interleaved = applyRetrievalToMastery(wrong, {
      correct: true,
      context: "INTERLEAVED",
      at,
    });
    expect(interleaved.mastery).toBe("LEARNING");
  });

  it("mastery climbs LEARNING -> STABLE -> STRONG on consecutive spaced successes", () => {
    let progress = p();
    const ladder: string[] = [];
    for (let i = 0; i < 3; i++) {
      progress = applyRetrievalToMastery(progress, {
        correct: true,
        context: "SPACED",
        at,
      });
      ladder.push(progress.mastery);
    }
    expect(ladder).toEqual(["LEARNING", "STABLE", "STRONG"]);
  });

  it("a failure at STRONG drops straight back to WEAK and resets the streak", () => {
    let progress = p();
    for (let i = 0; i < 3; i++) {
      progress = applyRetrievalToMastery(progress, {
        correct: true,
        context: "SPACED",
        at,
      });
    }
    expect(progress.mastery).toBe("STRONG");

    const lapsed = applyRetrievalToMastery(progress, {
      correct: false,
      context: "SPACED",
      at,
    });
    expect(lapsed.mastery).toBe("WEAK");
    expect(lapsed.consecutiveSpacedSuccesses).toBe(0);
  });

  it("an INITIAL success moves NEW to LEARNING but never rescues WEAK", () => {
    const first = applyRetrievalToMastery(p(), {
      correct: true,
      context: "INITIAL",
      at,
    });
    expect(first.mastery).toBe("LEARNING");

    const wrong = applyRetrievalToMastery(first, {
      correct: false,
      context: "INITIAL",
      at,
    });
    const initialAgain = applyRetrievalToMastery(wrong, {
      correct: true,
      context: "INITIAL",
      at,
    });
    expect(initialAgain.mastery).toBe("WEAK");
  });

  it("mastery is never reported as a fake percentage", () => {
    const states = ["NEW", "LEARNING", "WEAK", "STABLE", "STRONG"];
    expect(states).toContain(p().mastery);
    expect(masteryForStreak(0)).toBe("NEW");
    expect(masteryForStreak(9)).toBe("STRONG");
  });

  it("attempt counters track honestly", () => {
    let progress = p();
    progress = applyRetrievalToMastery(progress, { correct: true, context: "SPACED", at });
    progress = applyRetrievalToMastery(progress, { correct: false, context: "SPACED", at });
    expect(progress.totalAttempts).toBe(2);
    expect(progress.totalCorrect).toBe(1);
  });
});

describe("mastery through the engine", () => {
  it("wrong answer through recordAttempt marks WEAK", () => {
    const learner = answer(
      fresh(),
      "c-atp-depletion",
      "c-atp-1",
      "no idea",
      "INITIAL",
      T0,
    );
    expect(learner.progress["c-atp-depletion"]?.mastery).toBe("WEAK");
  });

  it("wrong then immediate-correct is still WEAK through the engine", () => {
    let learner = answer(fresh(), "c-atp-depletion", "c-atp-1", "no idea", "INITIAL", T0);
    learner = answer(
      learner,
      "c-atp-depletion",
      "c-atp-2",
      ANSWERS["c-atp-depletion"]!,
      "IMMEDIATE_REMEDIATION",
      T0,
    );
    expect(learner.progress["c-atp-depletion"]?.mastery).toBe("WEAK");
    expect(learner.progress["c-atp-depletion"]?.immediateRemediationPassed).toBe(true);
  });

  it("a spaced success days later finally clears the weakness", () => {
    let learner = answer(fresh(), "c-atp-depletion", "c-atp-1", "no idea", "INITIAL", T0);
    learner = answer(
      learner,
      "c-atp-depletion",
      "c-atp-2",
      ANSWERS["c-atp-depletion"]!,
      "IMMEDIATE_REMEDIATION",
      T0,
    );
    learner = answer(
      learner,
      "c-atp-depletion",
      "c-atp-3",
      ANSWERS["c-atp-depletion"]!,
      "SPACED",
      daysLater(3),
    );
    expect(learner.progress["c-atp-depletion"]?.mastery).toBe("LEARNING");
  });
});

describe("fsrs rating mapping", () => {
  it("a wrong answer is Again", () => {
    expect(ratingFor(false, "INITIAL")).toBe(Rating.Again);
  });

  it("a prompted remediation pass is Hard, never Good", () => {
    expect(ratingFor(true, "IMMEDIATE_REMEDIATION")).toBe(Rating.Hard);
  });

  it("an unaided success is Good", () => {
    expect(ratingFor(true, "SPACED")).toBe(Rating.Good);
    expect(ratingFor(true, "INTERLEAVED")).toBe(Rating.Good);
  });

  it("a remediation pass schedules a sooner return than a clean spaced pass", () => {
    const concept = getConcept(pathologyCurriculum, "c-atp-depletion");
    const base = createProgress(concept.id, newSchedule(T0));

    const remediated = scheduleAfterAttempt(
      concept,
      base,
      true,
      "IMMEDIATE_REMEDIATION",
      T0,
    );
    const clean = scheduleAfterAttempt(concept, base, true, "SPACED", T0);

    expect(new Date(remediated.due).getTime()).toBeLessThan(
      new Date(clean.due).getTime(),
    );
  });

  it("a failure schedules the soonest return of all", () => {
    const concept = getConcept(pathologyCurriculum, "c-atp-depletion");
    const base = createProgress(concept.id, newSchedule(T0));

    const failed = scheduleAfterAttempt(concept, base, false, "INITIAL", T0);
    const clean = scheduleAfterAttempt(concept, base, true, "SPACED", T0);

    expect(new Date(failed.due).getTime()).toBeLessThanOrEqual(
      new Date(clean.due).getTime(),
    );
    expect(failed.reps).toBeGreaterThan(0);
  });
});
