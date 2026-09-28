import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating,
  State,
  type Card,
  type Grade,
} from "ts-fsrs";
import { assertActive } from "@/lib/domain/gate";
import type {
  Concept,
  ConceptProgress,
  RetrievalContext,
  ScheduleState,
  SelfRating,
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

/**
 * Whether a concept is a due TUTOR review.
 *
 * Invariant: a concept-level schedule is a real tutor schedule only once FSRS
 * has recorded a concept-level review on it (`reps > 0`). Every tutor attempt
 * runs FSRS (`scheduleAfterAttempt`), so tutor-scheduled concepts are
 * unaffected by this rule. Card study keeps its own per-card schedules and
 * never advances the concept schedule, but it does create the concept's
 * progress record — with an untouched schedule whose `due` is the moment it
 * was created. Without this rule that placeholder would masquerade as a
 * review due immediately (Today queue, priority score, interleaving).
 *
 * WEAK concepts still surface regardless of due state wherever callers check
 * `mastery === "WEAK"` alongside this.
 */
export function isDue(progress: ConceptProgress, now: Date): boolean {
  if (progress.schedule.reps <= 0) return false;
  return new Date(progress.schedule.due).getTime() <= now.getTime();
}

/* ------------------------------------------------------------------ */
/* Anki-style self-rating                                               */
/* ------------------------------------------------------------------ */

/**
 * Self-ratings map one-to-one onto FSRS ratings. This is deliberately a
 * separate path from `ratingFor()`, which derives a rating from a graded
 * answer and never produces Easy.
 */
export const FSRS_RATING: Readonly<Record<SelfRating, Grade>> = Object.freeze({
  AGAIN: Rating.Again,
  HARD: Rating.Hard,
  GOOD: Rating.Good,
  EASY: Rating.Easy,
});

export const SELF_RATINGS: readonly SelfRating[] = ["AGAIN", "HARD", "GOOD", "EASY"];

/** Advance one study card's FSRS schedule for a self-rating. ACTIVE only. */
export function scheduleAfterRating(
  concept: Concept,
  schedule: ScheduleState,
  rating: SelfRating,
  now: Date,
): ScheduleState {
  assertActive(concept, "scheduling");
  const result = engine.next(toCard(schedule), now, FSRS_RATING[rating]);
  return toScheduleState(result.card);
}

/**
 * When each rating would schedule the card next — the interval hints Anki
 * shows on its buttons. Pure: nothing is recorded.
 */
export function previewRatings(
  schedule: ScheduleState,
  now: Date,
): Record<SelfRating, Date> {
  const outcomes = engine.repeat(toCard(schedule), now);
  return {
    AGAIN: outcomes[Rating.Again].card.due,
    HARD: outcomes[Rating.Hard].card.due,
    GOOD: outcomes[Rating.Good].card.due,
    EASY: outcomes[Rating.Easy].card.due,
  };
}

/** Which Anki queue a card's FSRS state belongs to. */
export function queueForSchedule(schedule: ScheduleState): "NEW" | "LEARNING" | "REVIEW" {
  if (schedule.state === State.New) return "NEW";
  if (schedule.state === State.Review) return "REVIEW";
  return "LEARNING";
}

/** Mastery context implied by a card's FSRS state before it is rated. */
export function contextForSchedule(schedule: ScheduleState): RetrievalContext {
  const queue = queueForSchedule(schedule);
  if (queue === "NEW") return "INITIAL";
  if (queue === "REVIEW") return "SPACED";
  return "IMMEDIATE_REMEDIATION";
}
