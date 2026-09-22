import { describe, expect, it } from "vitest";
import { pathologyCurriculum } from "@/lib/content/pathology";
import { LectureLockedError } from "@/lib/domain/errors";
import {
  createLearnerState,
  getNextStep,
  isLectureUnlocked,
  markChunkTaught,
  summarizeLectures,
  nextLecture,
} from "@/lib/engine/tutor";
import { DEMO_LECTURE_1, DEMO_LECTURE_2 } from "@/lib/content/pathology";
import { T0 } from "./helpers";
import { driveLecture } from "./driver";

describe("lecture unlock rules", () => {
  it("the first lecture is unlocked from the start", () => {
    const learner = createLearnerState();
    expect(isLectureUnlocked(pathologyCurriculum, learner, DEMO_LECTURE_1)).toBe(true);
  });

  it("the second lecture is locked until the first is complete", () => {
    const learner = createLearnerState();
    expect(isLectureUnlocked(pathologyCurriculum, learner, DEMO_LECTURE_2)).toBe(false);
  });

  it("entering a locked lecture throws rather than quietly allowing it", () => {
    const learner = createLearnerState();
    expect(() =>
      getNextStep(pathologyCurriculum, learner, DEMO_LECTURE_2, T0),
    ).toThrow(LectureLockedError);
  });

  it("a partially finished first lecture does NOT unlock the second", () => {
    let learner = createLearnerState();
    learner = markChunkTaught(pathologyCurriculum, learner, "chunk-ci-1");
    expect(isLectureUnlocked(pathologyCurriculum, learner, DEMO_LECTURE_2)).toBe(false);
  });

  it("reading every chunk without answering does NOT complete the lecture", () => {
    let learner = createLearnerState();
    for (const chunk of pathologyCurriculum.course.lectures[0]!.chunks) {
      learner = markChunkTaught(pathologyCurriculum, learner, chunk.id);
    }
    expect(learner.completedLectureIds).not.toContain(DEMO_LECTURE_1);
    expect(isLectureUnlocked(pathologyCurriculum, learner, DEMO_LECTURE_2)).toBe(false);
  });

  it("completing the first lecture unlocks the second", () => {
    const { learner } = driveLecture(createLearnerState(), DEMO_LECTURE_1, T0);
    expect(learner.completedLectureIds).toContain(DEMO_LECTURE_1);
    expect(isLectureUnlocked(pathologyCurriculum, learner, DEMO_LECTURE_2)).toBe(true);
  });

  it("completion is monotonic: a later lapse does not re-lock a finished lecture", () => {
    const { learner } = driveLecture(createLearnerState(), DEMO_LECTURE_1, T0);
    const lapsed = {
      ...learner,
      progress: {
        ...learner.progress,
        "c-atp-depletion": {
          ...learner.progress["c-atp-depletion"]!,
          mastery: "WEAK" as const,
          immediateRemediationPassed: false,
        },
      },
    };
    expect(isLectureUnlocked(pathologyCurriculum, lapsed, DEMO_LECTURE_2)).toBe(true);
  });

  it("summaries report lock state and weakness for the dashboard", () => {
    const learner = createLearnerState();
    const [first, second] = summarizeLectures(pathologyCurriculum, learner);
    expect(first!.unlocked).toBe(true);
    expect(second!.unlocked).toBe(false);
    expect(first!.totalConcepts).toBe(5); // drafts excluded
  });

  it("nextLecture points at the first unlocked, incomplete lecture", () => {
    const learner = createLearnerState();
    expect(nextLecture(pathologyCurriculum, learner)?.id).toBe(DEMO_LECTURE_1);
    const { learner: after } = driveLecture(learner, DEMO_LECTURE_1, T0);
    expect(nextLecture(pathologyCurriculum, after)?.id).toBe(DEMO_LECTURE_2);
  });

  it("teaching happens in small source-grounded chunks of 2-5 pages", () => {
    for (const lecture of pathologyCurriculum.course.lectures) {
      for (const chunk of lecture.chunks) {
        expect(chunk.pageNumbers.length, chunk.id).toBeGreaterThanOrEqual(2);
        expect(chunk.pageNumbers.length, chunk.id).toBeLessThanOrEqual(5);
      }
    }
  });

  it("teaching precedes retrieval within a chunk", () => {
    const { log } = driveLecture(createLearnerState(), DEMO_LECTURE_1, T0);
    const firstTeach = log.findIndex((l) => l.kind === "TEACH");
    const firstRetrieve = log.findIndex((l) => l.kind === "RETRIEVE");
    expect(firstTeach).toBeGreaterThanOrEqual(0);
    expect(firstTeach).toBeLessThan(firstRetrieve);
  });
});
