import { InvalidGradeError, StaleAttemptError } from "@/lib/domain/errors";
import { applySelfRatingToMastery } from "@/lib/domain/mastery";
import type {
  CardProgress,
  Concept,
  Curriculum,
  LearnerState,
  RetrievalItem,
  SelfRating,
} from "@/lib/domain/types";
import {
  contextForSchedule,
  newSchedule,
  queueForSchedule,
  scheduleAfterRating,
  SELF_RATINGS,
} from "./scheduler";
import {
  conceptsForLecture,
  ensureProgress,
  getLecture,
  reconcile,
  resolveAttemptTarget,
} from "./tutor";

/**
 * Anki-style card study.
 *
 * The learner studies CARDS: each RetrievalItem of an ACTIVE Concept is one
 * card, with its own FSRS schedule (`learner.cards`). They see the front,
 * reveal the back, and rate themselves Again / Hard / Good / Easy. There is no
 * typed answer and no grading call — the rating IS the assessment, so this
 * path never touches /api/grade.
 *
 * The Concept stays the internal unit of knowledge: every rating also feeds
 * that concept's mastery (see `applySelfRatingToMastery`), and provenance
 * comes from the concept's SourceRef.
 *
 * Pure and framework-free, like the rest of the engine.
 */

export type StudyQueueKind = "NEW" | "LEARNING" | "REVIEW";

export interface StudyCard {
  concept: Concept;
  item: RetrievalItem;
  /** Null for a card that has never been studied. */
  progress: CardProgress | null;
  queue: StudyQueueKind;
  due: Date;
}

export interface StudyCounts {
  new: number;
  learning: number;
  review: number;
}

export interface StudyQueue {
  counts: StudyCounts;
  /** Cards available now, in the order they will be shown. */
  queue: StudyCard[];
  next: StudyCard | null;
  /** When the next not-yet-available card becomes due, if any. */
  nextDueAt: Date | null;
}

/**
 * Learning cards due within this window are shown early when nothing else is
 * available, as Anki's "learn ahead limit" does — so a card failed a minute
 * ago does not leave the session stranded.
 */
export const LEARN_AHEAD_MS = 20 * 60_000;

/**
 * Every study card in a lecture, in teaching order.
 *
 * ACTIVE concepts only: DRAFT and DISCARDED concepts never produce a card. An
 * item that does not belong to its concept is skipped rather than studied.
 * First cards of every concept come before second cards, so two
 * representations of the same concept are not shown back to back.
 */
export function studyCardsForLecture(
  curriculum: Curriculum,
  lectureId: string,
): { concept: Concept; item: RetrievalItem }[] {
  const lecture = getLecture(curriculum, lectureId);
  const active = conceptsForLecture(curriculum, lectureId);
  const byId = new Map(active.map((c) => [c.id, c]));

  const ordered: Concept[] = [];
  const seen = new Set<string>();
  for (const chunk of [...lecture.chunks].sort((a, b) => a.order - b.order)) {
    for (const id of chunk.conceptIds) {
      const concept = byId.get(id);
      if (concept && !seen.has(id)) {
        seen.add(id);
        ordered.push(concept);
      }
    }
  }
  for (const concept of active) {
    if (!seen.has(concept.id)) ordered.push(concept);
  }

  const maxItems = Math.max(0, ...ordered.map((c) => c.retrievalItems.length));
  const cards: { concept: Concept; item: RetrievalItem }[] = [];
  for (let index = 0; index < maxItems; index++) {
    for (const concept of ordered) {
      const item = concept.retrievalItems[index];
      if (item && item.conceptId === concept.id) cards.push({ concept, item });
    }
  }
  return cards;
}

function cardProgress(learner: LearnerState, concept: Concept, item: RetrievalItem) {
  const progress = learner.cards?.[item.id];
  // A record for the same item id under a different concept is not this card.
  return progress && progress.conceptId === concept.id ? progress : null;
}

/**
 * Build the study queue for a lecture: counts plus the order cards are shown.
 *
 * Order: learning cards due now, then review cards due now (earliest first),
 * then new cards, then learning cards due within the learn-ahead window.
 * Review cards that are not yet due, and learning cards further out, are not
 * shown. Counts are derived from the same classification — nothing is
 * estimated.
 */
export function buildStudyQueue(
  curriculum: Curriculum,
  learner: LearnerState,
  lectureId: string,
  now: Date,
): StudyQueue {
  const t = now.getTime();
  const learningNow: StudyCard[] = [];
  const learningAhead: StudyCard[] = [];
  const reviewNow: StudyCard[] = [];
  const fresh: StudyCard[] = [];
  let nextDueAt: Date | null = null;

  for (const { concept, item } of studyCardsForLecture(curriculum, lectureId)) {
    const progress = cardProgress(learner, concept, item);
    if (!progress) {
      fresh.push({ concept, item, progress: null, queue: "NEW", due: now });
      continue;
    }
    const due = new Date(progress.schedule.due);
    const queue = queueForSchedule(progress.schedule);
    const card: StudyCard = { concept, item, progress, queue, due };
    if (queue === "NEW") {
      fresh.push(card);
    } else if (queue === "LEARNING") {
      if (due.getTime() <= t) learningNow.push(card);
      else if (due.getTime() <= t + LEARN_AHEAD_MS) learningAhead.push(card);
      else if (!nextDueAt || due < nextDueAt) nextDueAt = due;
    } else if (due.getTime() <= t) {
      reviewNow.push(card);
    } else if (!nextDueAt || due < nextDueAt) {
      nextDueAt = due;
    }
  }

  const byDue = (a: StudyCard, b: StudyCard) =>
    a.due.getTime() - b.due.getTime() || a.item.id.localeCompare(b.item.id);
  learningNow.sort(byDue);
  reviewNow.sort(byDue);
  learningAhead.sort(byDue);

  const queue = [...learningNow, ...reviewNow, ...fresh, ...learningAhead];
  return {
    counts: {
      new: fresh.length,
      learning: learningNow.length + learningAhead.length,
      review: reviewNow.length,
    },
    queue,
    next: queue[0] ?? null,
    nextDueAt,
  };
}

/* ------------------------------------------------------------------ */
/* Recording a rating                                                  */
/* ------------------------------------------------------------------ */

export interface CardRatingInput {
  conceptId: string;
  itemId: string;
  rating: SelfRating;
  now: Date;
}

/**
 * The card's version when it was shown. If the same card is rated again from
 * this snapshot — a double tap, or another tab rating it first — the second
 * rating is stale and is refused rather than recorded twice.
 */
export interface CardRatingPrecondition {
  itemId: string;
  reviews: number;
  lastReviewedAt: string | null;
}

export function captureCardPrecondition(
  learner: LearnerState,
  concept: Concept,
  item: RetrievalItem,
): CardRatingPrecondition {
  const progress = cardProgress(learner, concept, item);
  return {
    itemId: item.id,
    reviews: progress?.reviews ?? 0,
    lastReviewedAt: progress?.lastReviewedAt ?? null,
  };
}

export interface CardRatingResult {
  learner: LearnerState;
  card: CardProgress;
  concept: Concept;
  item: RetrievalItem;
}

/**
 * Record one self-rating: exactly one FSRS transition for the card, the
 * matching concept mastery transition, then derived completion. Pure — no
 * network, no React, no provider. Throws before touching anything if the
 * concept is not ACTIVE, the item is not the concept's, the rating is unknown,
 * or the precondition no longer holds.
 */
export function recordCardRating(
  curriculum: Curriculum,
  learner: LearnerState,
  input: CardRatingInput,
  precondition?: CardRatingPrecondition,
): CardRatingResult {
  // The approval gate and item membership, exactly as for graded attempts.
  const { concept, item } = resolveAttemptTarget(curriculum, input.conceptId, input.itemId);

  if (!SELF_RATINGS.includes(input.rating)) {
    throw new InvalidGradeError(`unknown self-rating ${String(input.rating)}`);
  }
  if (Number.isNaN(input.now.getTime())) {
    throw new InvalidGradeError("invalid rating time");
  }

  const previous = cardProgress(learner, concept, item);
  if (precondition) {
    if (precondition.itemId !== item.id) throw new StaleAttemptError("TARGET_MISMATCH");
    if (
      (previous?.reviews ?? 0) !== precondition.reviews ||
      (previous?.lastReviewedAt ?? null) !== precondition.lastReviewedAt
    ) {
      throw new StaleAttemptError("PROGRESS_CHANGED");
    }
  }
  const schedule = previous?.schedule ?? newSchedule(input.now);
  // FSRS is never run backwards.
  if (schedule.last_review && new Date(schedule.last_review).getTime() > input.now.getTime()) {
    throw new StaleAttemptError("OUT_OF_ORDER");
  }

  const at = input.now.toISOString();
  const context = contextForSchedule(schedule);
  const nextSchedule = scheduleAfterRating(concept, schedule, input.rating, input.now);

  const card: CardProgress = {
    itemId: item.id,
    conceptId: concept.id,
    schedule: nextSchedule,
    reviews: (previous?.reviews ?? 0) + 1,
    lastRating: input.rating,
    lastReviewedAt: at,
  };

  const conceptBefore = ensureProgress(learner, concept.id, input.now);
  const conceptAfter = applySelfRatingToMastery(conceptBefore, input.rating, context, at);

  const next = reconcile(curriculum, {
    ...learner,
    progress: { ...learner.progress, [concept.id]: conceptAfter },
    cards: { ...(learner.cards ?? {}), [item.id]: card },
  });

  return { learner: next, card, concept, item };
}

/**
 * Compact interval label for a rating button, in the style Anki uses:
 * "<1m", "10m", "3h", "4d", "2.5mo", "1.2y".
 */
export function formatInterval(ms: number): string {
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (ms < minute) return "<1m";
  if (ms < hour) return `${Math.round(ms / minute)}m`;
  if (ms < day) return `${Math.round(ms / hour)}h`;
  if (ms < 30 * day) return `${Math.round(ms / day)}d`;
  if (ms < 365 * day) return `${Math.round((ms / (30 * day)) * 10) / 10}mo`;
  return `${Math.round((ms / (365 * day)) * 10) / 10}y`;
}
