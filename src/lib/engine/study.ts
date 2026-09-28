import { InvalidGradeError, StaleAttemptError } from "@/lib/domain/errors";
import { applySelfRatingToMastery } from "@/lib/domain/mastery";
import type {
  CardFlags,
  CardProgress,
  Concept,
  Curriculum,
  LearnerState,
  RetrievalItem,
  SelfRating,
  StudyDayLog,
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
  gradingTargetFingerprint,
  pendingAfterStudyRating,
  reconcile,
  resolveAttemptTarget,
  withPendingTutorRemediation,
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
  /** New cards that will be shown (after the daily limit). */
  new: number;
  learning: number;
  /** Review cards due now that will be shown (after the daily limit). */
  review: number;
  suspended: number;
  buried: number;
}

/** Simple deck options, in Anki's terms. */
export interface StudyLimits {
  /** New cards introduced per local day. */
  newPerDay: number;
  /** Review-queue cards rated per local day. Learning steps are never limited. */
  reviewsPerDay: number;
}

export const DEFAULT_STUDY_LIMITS: StudyLimits = { newPerDay: 20, reviewsPerDay: 200 };

export interface StudyQueueOptions {
  /** Apply daily limits; without them every available card is shown. */
  limits?: StudyLimits;
  /** Show only cards due now (Learning and Review); no new cards. */
  dueOnly?: boolean;
}

export interface StudyQueue {
  counts: StudyCounts;
  /** Cards available now, in the order they will be shown. */
  queue: StudyCard[];
  next: StudyCard | null;
  /** When the next not-yet-available card becomes due, if any. */
  nextDueAt: Date | null;
  /** Cards available now but held back by the daily limits. */
  heldByLimits: { new: number; review: number };
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

/** Every studyable card in the course, lecture by lecture in course order. */
export function studyCardsForCourse(curriculum: Curriculum): { concept: Concept; item: RetrievalItem }[] {
  return [...curriculum.course.lectures]
    .sort((a, b) => a.order - b.order)
    .flatMap((lecture) => studyCardsForLecture(curriculum, lecture.id));
}

/* ------------------------------------------------------------------ */
/* Suspend / bury                                                      */
/* ------------------------------------------------------------------ */

export function cardFlagsFor(learner: LearnerState, itemId: string): CardFlags | null {
  return learner.cardFlags?.[itemId] ?? null;
}

export function isSuspended(flags: CardFlags | null | undefined): boolean {
  return flags?.suspended === true;
}

/** Buried until a stored time; expiry is simply that time passing. */
export function isBuried(flags: CardFlags | null | undefined, now: Date): boolean {
  if (!flags?.buriedUntil) return false;
  return new Date(flags.buriedUntil).getTime() > now.getTime();
}

/** Local calendar day of `at`, as YYYY-MM-DD. */
export function studyDayKey(at: Date): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, "0");
  const d = String(at.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** The next local midnight after `at`: when a burial made at `at` ends. */
export function endOfStudyDay(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1, 0, 0, 0, 0);
}

function withFlags(
  curriculum: Curriculum,
  learner: LearnerState,
  conceptId: string,
  itemId: string,
  update: (flags: CardFlags) => CardFlags | null,
): LearnerState {
  // The approval gate: DRAFT/DISCARDED cards are not Study cards at all.
  const { concept, item } = resolveAttemptTarget(curriculum, conceptId, itemId);
  const current = learner.cardFlags?.[item.id] ?? { conceptId: concept.id };
  const next = update({ ...current, conceptId: concept.id });
  const cardFlags = { ...(learner.cardFlags ?? {}) };
  if (next && (next.suspended || next.buriedUntil)) cardFlags[item.id] = next;
  else delete cardFlags[item.id];
  return { ...learner, cardFlags };
}

/** Suspend: out of the Study queue until resumed. FSRS history and mastery untouched. */
export function suspendCard(curriculum: Curriculum, learner: LearnerState, conceptId: string, itemId: string): LearnerState {
  return withFlags(curriculum, learner, conceptId, itemId, (f) => ({ ...f, suspended: true }));
}

export function resumeCard(curriculum: Curriculum, learner: LearnerState, conceptId: string, itemId: string): LearnerState {
  return withFlags(curriculum, learner, conceptId, itemId, ({ suspended: _s, ...f }) => {
    void _s;
    return f;
  });
}

/** Bury: out of the Study queue until the next local midnight. Deterministic from `now`. */
export function buryCard(curriculum: Curriculum, learner: LearnerState, conceptId: string, itemId: string, now: Date): LearnerState {
  if (Number.isNaN(now.getTime())) throw new InvalidGradeError("invalid bury time");
  return withFlags(curriculum, learner, conceptId, itemId, (f) => ({ ...f, buriedUntil: endOfStudyDay(now).toISOString() }));
}

export function unburyCard(curriculum: Curriculum, learner: LearnerState, conceptId: string, itemId: string): LearnerState {
  return withFlags(curriculum, learner, conceptId, itemId, ({ buriedUntil: _b, ...f }) => {
    void _b;
    return f;
  });
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
  options: StudyQueueOptions = {},
): StudyQueue {
  return buildStudyQueueFor(curriculum, learner, studyCardsForLecture(curriculum, lectureId), now, options);
}

/** Today's counts if `learner.studyDay` is for the local day of `now`, else zero. */
export function studyDayCounts(learner: LearnerState, now: Date): StudyDayLog {
  const day = studyDayKey(now);
  const log = learner.studyDay;
  return log && log.day === day ? log : { day, newIntroduced: 0, reviews: 0 };
}

/**
 * The queue over an explicit set of cards (a lecture, the course, or a custom
 * selection). Suspended and buried cards are counted but never queued. With
 * `limits`, new cards beyond today's remaining allowance and due reviews
 * beyond today's remaining allowance are held back (learning cards never
 * are); `heldByLimits` says how many.
 */
export function buildStudyQueueFor(
  curriculum: Curriculum,
  learner: LearnerState,
  cards: { concept: Concept; item: RetrievalItem }[],
  now: Date,
  options: StudyQueueOptions = {},
): StudyQueue {
  const t = now.getTime();
  const learningNow: StudyCard[] = [];
  const learningAhead: StudyCard[] = [];
  const reviewNow: StudyCard[] = [];
  const fresh: StudyCard[] = [];
  let suspended = 0;
  let buried = 0;
  let nextDueAt: Date | null = null;

  for (const { concept, item } of cards) {
    const flags = cardFlagsFor(learner, item.id);
    if (isSuspended(flags)) {
      suspended++;
      continue;
    }
    if (isBuried(flags, now)) {
      buried++;
      continue;
    }
    const progress = cardProgress(learner, concept, item);
    if (!progress) {
      if (!options.dueOnly) fresh.push({ concept, item, progress: null, queue: "NEW", due: now });
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

  // Daily limits: what is left of today's allowance, never below zero.
  let newAllowed = fresh.length;
  let reviewAllowed = reviewNow.length;
  if (options.limits) {
    const today = studyDayCounts(learner, now);
    newAllowed = Math.max(0, Math.min(fresh.length, options.limits.newPerDay - today.newIntroduced));
    reviewAllowed = Math.max(0, Math.min(reviewNow.length, options.limits.reviewsPerDay - today.reviews));
  }
  const shownNew = fresh.slice(0, newAllowed);
  const shownReview = reviewNow.slice(0, reviewAllowed);

  const queue = [...learningNow, ...shownReview, ...shownNew, ...learningAhead];
  return {
    counts: {
      new: shownNew.length,
      learning: learningNow.length + learningAhead.length,
      review: shownReview.length,
      suspended,
      buried,
    },
    queue,
    next: queue[0] ?? null,
    nextDueAt,
    heldByLimits: { new: fresh.length - shownNew.length, review: reviewNow.length - shownReview.length },
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
 * What the learner saw when they pressed Show Answer.
 *
 * - `reviews` / `lastReviewedAt`: the card's progress version. If the card is
 *   rated again from this snapshot — a double tap, or another tab rating it
 *   first — the second rating is stale.
 * - `target`: `gradingTargetFingerprint()` of the concept and item — identity,
 *   title, summary, status, full SourceRef, and the item's kind, prompt,
 *   rubric, accepted answers and explanation. Item ids survive human edits,
 *   so without this a rating made against the OLD content could be applied
 *   to NEW content. The same definition protects graded attempts (AD-20), so
 *   the two cannot drift apart.
 */
export interface CardRatingPrecondition {
  itemId: string;
  reviews: number;
  lastReviewedAt: string | null;
  target: string;
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
    target: gradingTargetFingerprint(concept, item),
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
 * or the precondition no longer holds (the card was rated since, or its
 * content changed since Show Answer).
 *
 * The concept-level FSRS schedule is NOT advanced here: cards have their own
 * schedules. A concept whose schedule has never been reviewed by the tutor is
 * therefore never a due tutor review (see `isDue`).
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
    // The card's content, source or status changed since Show Answer.
    if (gradingTargetFingerprint(concept, item) !== precondition.target) {
      throw new StaleAttemptError("TARGET_CHANGED");
    }
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

  // Today's tally for the daily limits: a first rating introduces a new card;
  // rating a Review-queue card is a review. Learning steps count as neither.
  const today = studyDayCounts(learner, input.now);
  const studyDay: StudyDayLog = {
    ...today,
    newIntroduced: today.newIntroduced + (previous ? 0 : 1),
    reviews: today.reviews + (previous && queueForSchedule(previous.schedule) === "REVIEW" ? 1 : 0),
  };

  const conceptBefore = ensureProgress(learner, concept.id, input.now);
  const rated = applySelfRatingToMastery(conceptBefore, input.rating, context, at);
  // A Study failure becomes a pending TUTOR remediation only once the Tutor
  // has retrieved the concept; see pendingAfterStudyRating.
  const conceptAfter = withPendingTutorRemediation(
    rated,
    pendingAfterStudyRating(conceptBefore, rated, input.rating),
  );

  const next = reconcile(curriculum, {
    ...learner,
    progress: { ...learner.progress, [concept.id]: conceptAfter },
    cards: { ...(learner.cards ?? {}), [item.id]: card },
    studyDay,
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
