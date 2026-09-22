import { pathologyCurriculum } from "@/lib/content/pathology";
import { createLearnerState, recordAttempt } from "@/lib/engine/tutor";
import type { Curriculum, LearnerState } from "@/lib/domain/types";

export const CORRECT_ATP =
  "ATP depletion makes the Na/K ATPase pump fail so sodium and water enter the cell and cause swelling";
export const WRONG = "I do not remember this at all";

export const ANSWERS: Record<string, string> = {
  "c-hypoxia": "hypoxia is the commonest cause and ischaemia causes it by removing substrate and waste clearance",
  "c-reversible-irreversible": "severe membrane damage marks irreversible injury with swelling in reversible",
  "c-atp-depletion": CORRECT_ATP,
  "c-na-k-atpase": "three sodium out for two potassium in and it uses lots of atp so it accumulates",
  "c-cellular-swelling": "water follows sodium osmotically so the cell shows swelling",
  "c-cardinal-signs": "rubor calor tumor dolor and functio laesa",
  "c-vasodilation": "vasodilation raises flow and increased permeability makes exudate",
  "c-margination": "selectins roll and integrins adhere which is margination",
  "c-chemotaxis": "c5a and il-8 along a chemical gradient",
};

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
