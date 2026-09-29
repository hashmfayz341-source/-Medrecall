import type { Curriculum, LearnerState, Lecture } from "@/lib/domain/types";
import { queueForSchedule } from "./scheduler";
import { cardFlagsFor, isBuried, isSuspended, studyCardsForLecture, type StudyCard } from "./study";

/**
 * The session composer: WHAT appears next while studying one lecture.
 *
 * FSRS stays authoritative for WHEN a card is due — nothing here reads or
 * writes a schedule. The composer only decides the order of the session:
 * the current lecture's own queue, with older cards from other lectures
 * that FSRS says are overdue, due, or about to come due mixed in, about one
 * after every `REVIEW_EVERY` current cards. Rating an inserted card records
 * exactly as it would in its own lecture (same `recordCardRating`, same
 * FSRS history, same provenance); it never joins the current lecture.
 */

/** Cards due within this window count as "near forgetting". Conservative: the next day. */
export const NEAR_DUE_HORIZON_MS = 24 * 60 * 60_000;
/** A card whose due time passed more than this long ago is overdue rather than merely due. */
export const OVERDUE_AFTER_MS = 24 * 60 * 60_000;
/** Insert one old review after this many current-lecture cards. */
export const REVIEW_EVERY = 4;

export type OldReviewReason = "overdue" | "due" | "near";

export interface OldReview {
  card: StudyCard;
  reason: OldReviewReason;
  lecture: Lecture;
}

const REASON_RANK: Record<OldReviewReason, number> = { overdue: 0, due: 1, near: 2 };

/**
 * Cards of OTHER lectures that qualify for insertion, most urgent first:
 * overdue, then due now, then due within the horizon. Never new cards
 * (FSRS has no memory of them yet), never suspended or buried ones, never
 * the current lecture's own cards. Reads existing FSRS data only.
 */
export interface EligibilityOptions {
  /** Cards due within this window count as near-due. */
  horizonMs?: number;
  /**
   * Item ids of old reviews already rated in this session. Once rated, a
   * card is eligible again only when FSRS actually makes it due (Again's
   * learning step, minutes away), never merely near-due: Hard, Good and
   * Easy push it past the session.
   */
  ratedThisSession?: ReadonlySet<string>;
}

export function eligibleOldReviews(
  curriculum: Curriculum,
  learner: LearnerState,
  currentLectureId: string,
  now: Date,
  options: EligibilityOptions | number = {},
): OldReview[] {
  const { horizonMs = NEAR_DUE_HORIZON_MS, ratedThisSession } = typeof options === "number" ? { horizonMs: options } : options;
  const t = now.getTime();
  const out: OldReview[] = [];
  for (const lecture of curriculum.course.lectures) {
    if (lecture.id === currentLectureId) continue;
    for (const { concept, item } of studyCardsForLecture(curriculum, lecture.id)) {
      const flags = cardFlagsFor(learner, item.id);
      if (isSuspended(flags) || isBuried(flags, now)) continue;
      const progress = learner.cards?.[item.id];
      if (!progress || progress.conceptId !== concept.id) continue;
      const queue = queueForSchedule(progress.schedule);
      if (queue === "NEW") continue;
      const due = new Date(progress.schedule.due);
      const dueAt = due.getTime();
      let reason: OldReviewReason;
      if (dueAt <= t - OVERDUE_AFTER_MS) reason = "overdue";
      else if (dueAt <= t) reason = "due";
      else if (dueAt <= t + horizonMs && !ratedThisSession?.has(item.id)) reason = "near";
      else continue;
      out.push({ card: { concept, item, progress, queue, due }, reason, lecture });
    }
  }
  return out.sort(
    (a, b) =>
      REASON_RANK[a.reason] - REASON_RANK[b.reason] ||
      a.card.due.getTime() - b.card.due.getTime() ||
      a.card.item.id.localeCompare(b.card.item.id),
  );
}

export interface SessionCard extends StudyCard {
  origin: "current" | "review";
  /** Set for an inserted old review. */
  reason?: OldReviewReason;
  /** The lecture the card belongs to (the current one, or the old card's own). */
  lecture: Lecture;
}

export interface ComposeOptions {
  /** Current-lecture cards between two old reviews. */
  every?: number;
  /**
   * What is left of today's reviews-per-day allowance for inserted REVIEW-queue
   * cards (learning cards are never limited, as in the lecture's own queue).
   * Undefined means no limit (custom study that ignores limits).
   */
  maxReviews?: number;
  /**
   * Current-lecture cards rated since the last inserted review (or since the
   * session began). The session keeps this count so the cadence holds as the
   * queue shifts; the composer itself is stateless.
   */
  currentSinceReview?: number;
}

/**
 * Interleave old reviews into the current queue: after every `every`
 * current cards one old review, most urgent first, each at most once. When
 * no old review is eligible the current queue is returned unchanged — the
 * ratio is never forced. Once the current queue is exhausted the remaining
 * overdue and due reviews follow (they are owed); near-due ones only ride
 * the cadence, so they never swamp a short session.
 */
export function composeSession(
  current: readonly StudyCard[],
  currentLecture: Lecture,
  old: readonly OldReview[],
  options: ComposeOptions = {},
): SessionCard[] {
  const every = Math.max(1, options.every ?? REVIEW_EVERY);
  const since = Math.max(0, options.currentSinceReview ?? 0);
  const inserted = new Set<string>();
  // The daily allowance: the most urgent review-queue cards first, learning
  // cards regardless (they are steps of a review already counted).
  let allowance = options.maxReviews === undefined ? Infinity : Math.max(0, options.maxReviews);
  const queue = old.filter((r) => {
    if (r.card.queue !== "REVIEW") return true;
    if (allowance <= 0) return false;
    allowance--;
    return true;
  });
  const out: SessionCard[] = [];
  const takeOld = (): SessionCard | null => {
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (inserted.has(next.card.item.id)) continue;
      inserted.add(next.card.item.id);
      return { ...next.card, origin: "review", reason: next.reason, lecture: next.lecture };
    }
    return null;
  };

  // Four (or more) current cards already rated since the last review: the
  // next card is a review, whatever the queue looks like now.
  let sinceReview = Math.min(since, every);
  for (const card of current) {
    if (sinceReview >= every) {
      const review = takeOld();
      if (review) out.push(review);
      sinceReview = 0;
    }
    out.push({ ...card, origin: "current", lecture: currentLecture });
    sinceReview++;
  }
  if (current.length === 0 || sinceReview >= every) {
    // The cadence boundary lands after the last current card, or there was
    // nothing current at all: the next review goes here.
    const review = takeOld();
    if (review) out.push(review);
  }
  for (const rest of queue) {
    if (rest.reason === "near" || inserted.has(rest.card.item.id)) continue;
    inserted.add(rest.card.item.id);
    out.push({ ...rest.card, origin: "review", reason: rest.reason, lecture: rest.lecture });
  }
  return out;
}
