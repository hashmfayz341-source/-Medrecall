import { describe, expect, it } from "vitest";
import { pathologyCurriculum } from "@/lib/content/pathology";
import { ConceptNotActiveError } from "@/lib/domain/errors";
import { activeOnly, assertActive } from "@/lib/domain/gate";
import { buildTodayQueue } from "@/lib/engine/priority";
import { scheduleAfterAttempt, newSchedule } from "@/lib/engine/scheduler";
import {
  conceptsForChunk,
  conceptsForLecture,
  createLearnerState,
  getConcept,
  getNextStep,
  markChunkTaught,
  recordAttempt,
  selectInterleavedConcept,
} from "@/lib/engine/tutor";
import { createProgress } from "@/lib/domain/mastery";
import { ANSWERS, T0, answer, daysLater } from "./helpers";
import type { Concept, LearnerState } from "@/lib/domain/types";

const DRAFT_ID = "c-draft-lysosomal";
const DRAFT_L2 = "c-draft-chronic";

function draft(): Concept {
  return getConcept(pathologyCurriculum, DRAFT_ID);
}

describe("concept approval gate", () => {
  it("the demo curriculum actually contains DRAFT concepts", () => {
    const drafts = pathologyCurriculum.concepts.filter((c) => c.status === "DRAFT");
    expect(drafts.map((c) => c.id)).toContain(DRAFT_ID);
    expect(drafts.map((c) => c.id)).toContain(DRAFT_L2);
  });

  it("DRAFT concepts cannot enter TEACHING", () => {
    // The draft is listed on the chunk, but never surfaces as a taught concept.
    const chunk = pathologyCurriculum.course.lectures[0]!.chunks[0]!;
    expect(chunk.conceptIds).toContain(DRAFT_ID);

    const taught = conceptsForChunk(pathologyCurriculum, chunk);
    expect(taught.map((c) => c.id)).not.toContain(DRAFT_ID);

    const learner = createLearnerState();
    const step = getNextStep(
      pathologyCurriculum,
      learner,
      pathologyCurriculum.course.lectures[0]!.id,
      T0,
    );
    expect(step.kind).toBe("TEACH");
    if (step.kind === "TEACH") {
      expect(step.concepts.map((c) => c.id)).not.toContain(DRAFT_ID);
    }

    expect(() => assertActive(draft(), "teaching")).toThrow(ConceptNotActiveError);
  });

  it("DRAFT concepts cannot enter RETRIEVAL", () => {
    const learner = createLearnerState();
    expect(() =>
      recordAttempt(pathologyCurriculum, learner, {
        conceptId: DRAFT_ID,
        itemId: "c-draft-lyso-1",
        answer: "hydrolases",
        context: "INITIAL",
        now: T0,
      }),
    ).toThrow(ConceptNotActiveError);
  });

  it("DRAFT concepts cannot enter SCHEDULING", () => {
    const progress = createProgress(DRAFT_ID, newSchedule(T0));
    expect(() =>
      scheduleAfterAttempt(draft(), progress, true, "SPACED", T0),
    ).toThrow(ConceptNotActiveError);
  });

  it("DRAFT concepts cannot enter the TODAY queue", () => {
    // Force progress onto the draft, as a corrupted/hand-edited store might.
    const learner: LearnerState = {
      ...createLearnerState(),
      progress: {
        [DRAFT_ID]: {
          ...createProgress(DRAFT_ID, newSchedule(T0)),
          mastery: "WEAK",
          totalAttempts: 3,
          everWrong: true,
        },
      },
    };
    const queue = buildTodayQueue(pathologyCurriculum, learner, daysLater(30));
    expect(queue.map((e) => e.concept.id)).not.toContain(DRAFT_ID);
  });

  it("DRAFT concepts cannot enter INTERLEAVING", () => {
    const learner: LearnerState = {
      ...createLearnerState(),
      progress: {
        [DRAFT_ID]: {
          ...createProgress(DRAFT_ID, newSchedule(T0)),
          mastery: "WEAK",
          totalAttempts: 3,
          everWrong: true,
        },
      },
    };
    const picked = selectInterleavedConcept(
      pathologyCurriculum,
      learner,
      pathologyCurriculum.course.lectures[1]!.id,
      "chunk-inf-1",
      daysLater(30),
    );
    expect(picked?.id).not.toBe(DRAFT_ID);
    expect(picked).toBeNull();
  });

  it("DRAFT concepts cannot enter MASTERY reporting for a lecture", () => {
    const lectureConcepts = conceptsForLecture(
      pathologyCurriculum,
      pathologyCurriculum.course.lectures[0]!.id,
    );
    expect(lectureConcepts.map((c) => c.id)).not.toContain(DRAFT_ID);
  });

  it("ACTIVE concepts CAN enter learning", () => {
    const active = getConcept(pathologyCurriculum, "c-hypoxia");
    expect(() => assertActive(active, "retrieval")).not.toThrow();
    expect(activeOnly(pathologyCurriculum.concepts).map((c) => c.id)).toContain(
      "c-hypoxia",
    );

    const learner = answer(
      createLearnerState(),
      "c-hypoxia",
      "c-hypoxia-1",
      ANSWERS["c-hypoxia"]!,
      "INITIAL",
      T0,
    );
    expect(learner.progress["c-hypoxia"]?.totalAttempts).toBe(1);
    expect(learner.progress["c-hypoxia"]?.mastery).toBe("LEARNING");
  });

  it("approving a draft lets it into teaching", () => {
    const approved = {
      ...pathologyCurriculum,
      concepts: pathologyCurriculum.concepts.map((c) =>
        c.id === DRAFT_ID ? { ...c, status: "ACTIVE" as const } : c,
      ),
    };
    const chunk = approved.course.lectures[0]!.chunks[0]!;
    expect(conceptsForChunk(approved, chunk).map((c) => c.id)).toContain(DRAFT_ID);
  });

  it("a discarded concept is excluded just like a draft", () => {
    const discarded = {
      ...pathologyCurriculum,
      concepts: pathologyCurriculum.concepts.map((c) =>
        c.id === "c-hypoxia" ? { ...c, status: "DISCARDED" as const } : c,
      ),
    };
    const chunk = discarded.course.lectures[0]!.chunks[0]!;
    expect(conceptsForChunk(discarded, chunk).map((c) => c.id)).not.toContain(
      "c-hypoxia",
    );
  });

  it("gating survives a full chunk walkthrough: the draft is never tested", () => {
    let learner = createLearnerState();
    const lectureId = pathologyCurriculum.course.lectures[0]!.id;
    learner = markChunkTaught(pathologyCurriculum, learner, "chunk-ci-1");

    const seen: string[] = [];
    for (let i = 0; i < 10; i++) {
      const step = getNextStep(pathologyCurriculum, learner, lectureId, T0);
      if (step.kind !== "RETRIEVE") break;
      seen.push(step.concept.id);
      learner = answer(
        learner,
        step.concept.id,
        step.item.id,
        ANSWERS[step.concept.id] ?? "",
        "INITIAL",
        T0,
        step.chunk.id,
      );
    }
    expect(seen).not.toContain(DRAFT_ID);
    expect(seen).toContain("c-hypoxia");
  });
});
