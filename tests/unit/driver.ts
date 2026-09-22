import { pathologyCurriculum } from "@/lib/content/pathology";
import {
  getNextStep,
  markChunkTaught,
  recordAttempt,
  type SessionStep,
} from "@/lib/engine/tutor";
import type { LearnerState } from "@/lib/domain/types";
import { ANSWERS, WRONG } from "./helpers";

export interface StepLog {
  kind: SessionStep["kind"];
  conceptId?: string;
  itemId?: string;
  correct?: boolean;
  mastery?: string;
}

export type AnswerFn = (step: SessionStep, log: StepLog[]) => string;

/** Default: answer everything correctly. */
export const answerCorrectly: AnswerFn = (step) =>
  step.kind === "RETRIEVE" ||
  step.kind === "REMEDIATE" ||
  step.kind === "INTERLEAVE"
    ? (ANSWERS[step.concept.id] ?? WRONG)
    : "";

/**
 * Walk a lecture the way the UI does: ask the engine for the next step, act on
 * it, feed the result back. Stops at LECTURE_COMPLETE or the step cap.
 */
export function driveLecture(
  learner: LearnerState,
  lectureId: string,
  now: Date,
  answerFn: AnswerFn = answerCorrectly,
  maxSteps = 60,
): { learner: LearnerState; log: StepLog[] } {
  const log: StepLog[] = [];
  let state = learner;

  for (let i = 0; i < maxSteps; i++) {
    const step = getNextStep(pathologyCurriculum, state, lectureId, now);

    if (step.kind === "LECTURE_COMPLETE") {
      log.push({ kind: step.kind });
      return { learner: state, log };
    }

    if (step.kind === "TEACH") {
      log.push({ kind: step.kind });
      state = markChunkTaught(pathologyCurriculum, state, step.chunk.id);
      continue;
    }

    const text = answerFn(step, log);
    const result = recordAttempt(pathologyCurriculum, state, {
      conceptId: step.concept.id,
      itemId: step.item.id,
      answer: text,
      context: step.context,
      chunkId: step.chunk.id,
      now,
    });
    state = result.learner;
    log.push({
      kind: step.kind,
      conceptId: step.concept.id,
      itemId: step.item.id,
      correct: result.grade.correct,
      mastery: result.progress.mastery,
    });
  }

  throw new Error(`driveLecture exceeded ${maxSteps} steps`);
}
