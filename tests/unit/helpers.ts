import { pathologyCurriculum } from "@/lib/content/pathology";
import { createLearnerState, recordAttempt } from "@/lib/engine/tutor";
import type { Curriculum, LearnerState } from "@/lib/domain/types";

export { ANSWERS, CORRECT_ATP, WRONG } from "../answers";

export function freshCurriculum(): Curriculum {
  return pathologyCurriculum;
}

export function fresh(): LearnerState {
  return createLearnerState();
}

/** Answer a concept in a given context, returning the updated learner state. */
export function answer(
  learner: LearnerState,
  conceptId: string,
  itemId: string,
  text: string,
  context: Parameters<typeof recordAttempt>[2]["context"],
  now: Date,
  chunkId?: string,
): LearnerState {
  return recordAttempt(pathologyCurriculum, learner, {
    conceptId,
    itemId,
    answer: text,
    context,
    chunkId,
    now,
  }).learner;
}

export const T0 = new Date("2026-01-01T09:00:00.000Z");
export function daysLater(days: number): Date {
  return new Date(T0.getTime() + days * 86_400_000);
}
