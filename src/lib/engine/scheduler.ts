import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating,
  type Card,
  type Grade,
} from "ts-fsrs";
import { assertActive } from "@/lib/domain/gate";
import type {
  Concept,
  ConceptProgress,
  RetrievalContext,
  ScheduleState,
} from "@/lib/domain/types";

/**
 * Scheduling: FSRS decides WHEN a concept comes back. MedRecall decides WHAT
 * is taught and HOW it is tested. Keeping that split means we can adopt FSRS
 * improvements without touching the tutoring logic.
 */

const params = generatorParameters({ enable_fuzz: false });
const engine = fsrs(params);

export function toScheduleState(card: Card): ScheduleState {
  return {
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    last_review: card.last_review ? card.last_review.toISOString() : undefined,
  };
}

export function toCard(state: ScheduleState): Card {
  return {
    due: new Date(state.due),
    stability: state.stability,
    difficulty: state.difficulty,
    elapsed_days: state.elapsed_days,
    scheduled_days: state.scheduled_days,
    learning_steps: state.learning_steps,
    reps: state.reps,
    lapses: state.lapses,
    state: state.state,
    last_review: state.last_review ? new Date(state.last_review) : undefined,
  } as Card;
}

export function newSchedule(now: Date): ScheduleState {
  return toScheduleState(createEmptyCard(now));
}

/**
 * Map a retrieval outcome onto an FSRS grade.
 *
 * A pass during immediate remediation is graded HARD, never GOOD: the learner
 * did recover, but the concept must come back soon and must not earn a long
 * interval from a prompted answer.
 */
export function ratingFor(correct: boolean, context: RetrievalContext): Grade {
  if (!correct) return Rating.Again;
  if (context === "IMMEDIATE_REMEDIATION") return Rating.Hard;
  return Rating.Good;
}

/** Advance the FSRS card for one graded attempt. Gated on ACTIVE concepts. */
export function scheduleAfterAttempt(
  concept: Concept,
  progress: ConceptProgress,
  correct: boolean,
  context: RetrievalContext,
  now: Date,
): ScheduleState {
  assertActive(concept, "scheduling");
  const card = toCard(progress.schedule);
  const rating = ratingFor(correct, context);
  const result = engine.next(card, now, rating);
  return toScheduleState(result.card);
}

export function isDue(progress: ConceptProgress, now: Date): boolean {
  return new Date(progress.schedule.due).getTime() <= now.getTime();
}
