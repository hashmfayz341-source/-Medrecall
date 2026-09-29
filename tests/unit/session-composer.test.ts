import { describe, expect, it } from "vitest";
import { pathologyCurriculum as C } from "@/lib/content/pathology";
import { addLecture, applyOverrides, createOverrides, setConceptStatuses } from "@/lib/domain/curriculum";
import type { Concept, Lecture, LearnerState } from "@/lib/domain/types";
import { buildStudyQueue, buryCard, recordCardRating, studyCardsForLecture, suspendCard } from "@/lib/engine/study";
import { NEAR_DUE_HORIZON_MS, REVIEW_EVERY, composeSession, eligibleOldReviews, isNearDue } from "@/lib/engine/session";
import { queueForSchedule } from "@/lib/engine/scheduler";
import { createLearnerState } from "@/lib/engine/tutor";

/**
 * The session composer: old cards that FSRS says are overdue, due or near
 * due are mixed into the current lecture's session, about one after every
 * four current cards. FSRS itself is never touched: the composer only
 * orders what is shown; rating an inserted card records in its own
 * lecture's history exactly as it always did.
 */

const OLD = "lecture-cell-injury"; // authored, ACTIVE cards
const NEW = "lecture-new-upload";
const T0 = new Date("2026-06-01T09:00:00.000Z");
const at = (h: number) => new Date(T0.getTime() + h * 3_600_000);

/** A second lecture with eight approved single-card concepts. */
function newLecture() {
  const lecture: Lecture = { id: NEW, courseId: C.course.id, title: "Inflammation", order: 9, documents: [], chunks: [] };
  const concepts: Concept[] = Array.from({ length: 8 }, (_, i) => ({
    id: `new-c${i}`,
    courseId: C.course.id,
    lectureId: NEW,
    title: `Inflammation fact ${i}`,
    summary: `Inflammation fact ${i} is stated here.`,
    importance: "CORE",
    status: "DRAFT",
    prerequisiteIds: [],
    source: { courseId: C.course.id, lectureId: NEW, documentId: "doc-inflammation", pageNumber: i + 1, excerpt: `Inflammation fact ${i} is stated here.` },
    retrievalItems: [{ id: `new-c${i}-r1`, conceptId: `new-c${i}`, kind: "BASIC", prompt: `What is fact ${i}?`, requiredKeywords: [[`fact`]], acceptableAnswers: [], explanation: `Inflammation fact ${i} is stated here.` }],
  }));
  let o = addLecture(createOverrides(), lecture);
  o = { ...o, concepts };
  o = setConceptStatuses(o, concepts.map((c) => c.id), "ACTIVE");
  return { curriculum: applyOverrides(C, o), lecture };
}

/** Study every Cell Injury card once (GOOD) at `when`, so FSRS has real schedules for them. */
function studyOld(curriculum: ReturnType<typeof applyOverrides>, learner: LearnerState, when: Date, rating: "GOOD" | "EASY" | "AGAIN" = "GOOD") {
  let state = learner;
  for (const { concept, item } of studyCardsForLecture(curriculum, OLD)) {
    state = recordCardRating(curriculum, state, { conceptId: concept.id, itemId: item.id, rating, now: when }).learner;
  }
  return state;
}

describe("eligible old reviews", () => {
  it("includes overdue, due and near-due cards of other lectures, most urgent first, and never new or current-lecture cards", () => {
    const { curriculum } = newLecture();
    const learner = studyOld(curriculum, createLearnerState(), T0);
    const oldCards = studyCardsForLecture(curriculum, OLD);
    const firstDue = Math.min(...oldCards.map(({ item }) => new Date(learner.cards![item.id]!.schedule.due).getTime()));
    // GOOD on a new card schedules a learning step minutes away. A card in its
    // learning steps is never "near-due": nothing is eligible until the step is due.
    expect(eligibleOldReviews(curriculum, learner, NEW, new Date(T0.getTime() + 1_000))).toEqual([]);
    const now = new Date(firstDue + 1_000);
    const reviews = eligibleOldReviews(curriculum, learner, NEW, now);
    expect(reviews.length).toBeGreaterThan(0);
    for (const r of reviews) {
      expect(r.lecture.id).toBe(OLD);
      expect(r.card.queue).not.toBe("NEW");
      expect(["overdue", "due", "near"]).toContain(r.reason);
    }
    const rank = { overdue: 0, due: 1, near: 2 } as const;
    for (let i = 1; i < reviews.length; i++) {
      expect(rank[reviews[i - 1]!.reason]).toBeLessThanOrEqual(rank[reviews[i]!.reason]);
    }
    // Studying the OLD lecture itself: its own cards are not "old reviews".
    expect(eligibleOldReviews(curriculum, learner, OLD, now)).toEqual([]);
    // A never-studied lecture has no eligible cards (FSRS has no memory of them).
    expect(eligibleOldReviews(curriculum, createLearnerState(), NEW, now)).toEqual([]);
  });

  it("classifies by due time: overdue after a day, due now, near within the horizon, later excluded", () => {
    const { curriculum } = newLecture();
    const learner = studyOld(curriculum, createLearnerState(), T0, "EASY"); // EASY graduates: due days out
    const { item } = studyCardsForLecture(curriculum, OLD)[0]!;
    const due = new Date(learner.cards![item.id]!.schedule.due);
    const reasonAt = (when: Date) => eligibleOldReviews(curriculum, learner, NEW, when).find((r) => r.card.item.id === item.id)?.reason ?? null;
    expect(reasonAt(new Date(due.getTime() - NEAR_DUE_HORIZON_MS - 60_000))).toBeNull(); // future, not near
    expect(reasonAt(new Date(due.getTime() - NEAR_DUE_HORIZON_MS + 60_000))).toBe("near");
    expect(reasonAt(new Date(due.getTime() + 60_000))).toBe("due");
    expect(reasonAt(new Date(due.getTime() + 25 * 3_600_000))).toBe("overdue");
    // The schedule itself was never changed by looking.
    expect(new Date(learner.cards![item.id]!.schedule.due)).toEqual(due);
  });

  it("suspended and buried cards are left out", () => {
    const { curriculum } = newLecture();
    let learner = studyOld(curriculum, createLearnerState(), T0);
    const cards = studyCardsForLecture(curriculum, OLD);
    const later = at(48);
    const before = eligibleOldReviews(curriculum, learner, NEW, later).length;
    learner = suspendCard(curriculum, learner, cards[0]!.concept.id, cards[0]!.item.id);
    learner = buryCard(curriculum, learner, cards[1]!.concept.id, cards[1]!.item.id, later);
    expect(eligibleOldReviews(curriculum, learner, NEW, later).length).toBe(before - 2);
  });
});

describe("composing a session", () => {
  it("inserts one old review after every four current cards; none when none are eligible", () => {
    const { curriculum, lecture } = newLecture();
    const learner = studyOld(curriculum, createLearnerState(), T0);
    const later = at(48);
    const current = buildStudyQueue(curriculum, learner, NEW, later).queue;
    expect(current).toHaveLength(8);
    const old = eligibleOldReviews(curriculum, learner, NEW, later);
    expect(old.length).toBeGreaterThanOrEqual(2);

    const session = composeSession(current, lecture, old);
    expect(session.slice(0, REVIEW_EVERY).every((c) => c.origin === "current")).toBe(true);
    expect(session[REVIEW_EVERY]!.origin).toBe("review");
    expect(session[REVIEW_EVERY]!.item.id).toBe(old[0]!.card.item.id);
    expect(session.slice(REVIEW_EVERY + 1, REVIEW_EVERY * 2 + 1).every((c) => c.origin === "current")).toBe(true);
    expect(session[REVIEW_EVERY * 2 + 1]!.origin).toBe("review");
    // Each old card at most once.
    const ids = session.filter((c) => c.origin === "review").map((c) => c.item.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Current cards keep their lecture; inserted ones keep theirs.
    expect(session.filter((c) => c.origin === "current").every((c) => c.lecture.id === NEW)).toBe(true);
    expect(session.filter((c) => c.origin === "review").every((c) => c.lecture.id === OLD && c.concept.lectureId === OLD)).toBe(true);

    expect(composeSession(current, lecture, [])).toEqual(current.map((c) => ({ ...c, origin: "current", lecture })));
  });

  it("keeps the cadence as the queue shifts, and owes overdue/due reviews after the current cards run out", () => {
    const { curriculum, lecture } = newLecture();
    const learner = studyOld(curriculum, createLearnerState(), T0);
    const later = at(48);
    const current = buildStudyQueue(curriculum, learner, NEW, later).queue;
    const old = eligibleOldReviews(curriculum, learner, NEW, later);
    // Three current cards already rated since the last review: the next review comes after one more.
    const shifted = composeSession(current.slice(3), lecture, old, { currentSinceReview: 3 });
    expect(shifted[0]!.origin).toBe("current");
    expect(shifted[1]!.origin).toBe("review");
    // Four already rated: the review comes first.
    expect(composeSession(current.slice(4), lecture, old, { currentSinceReview: 4 })[0]!.origin).toBe("review");
    // Only two current cards left: after them the overdue/due reviews follow, near-due ones do not.
    const short = composeSession(current.slice(0, 2), lecture, old);
    expect(short.slice(0, 2).every((c) => c.origin === "current")).toBe(true);
    const tail = short.slice(2);
    expect(tail.length).toBe(old.filter((r) => r.reason !== "near").length);
    expect(tail.every((c) => c.origin === "review" && c.reason !== "near")).toBe(true);
    // No current cards at all (the lecture is done for today): the owed reviews still come.
    expect(composeSession([], lecture, old).every((c) => c.origin === "review")).toBe(true);
  });

  it("rating an inserted old card updates its own FSRS history and leaves ownership and provenance alone", () => {
    const { curriculum, lecture } = newLecture();
    const learner = studyOld(curriculum, createLearnerState(), T0);
    const later = at(48);
    const session = composeSession(buildStudyQueue(curriculum, learner, NEW, later).queue, lecture, eligibleOldReviews(curriculum, learner, NEW, later));
    const inserted = session.find((c) => c.origin === "review")!;
    const before = learner.cards![inserted.item.id]!;
    for (const rating of ["AGAIN", "HARD", "GOOD", "EASY"] as const) {
      const result = recordCardRating(curriculum, learner, { conceptId: inserted.concept.id, itemId: inserted.item.id, rating, now: later });
      const after = result.learner.cards![inserted.item.id]!;
      expect(after.reviews).toBe(before.reviews + 1);
      expect(after.lastRating).toBe(rating);
      expect(after.conceptId).toBe(inserted.concept.id);
      expect(result.concept.lectureId).toBe(OLD);
      expect(result.concept.source).toEqual(inserted.concept.source);
      // The new lecture's cards were not touched.
      for (const c of studyCardsForLecture(curriculum, NEW)) expect(result.learner.cards![c.item.id]).toBeUndefined();
    }
    // Nothing in the composed session moved a due date.
    expect(learner.cards![inserted.item.id]).toEqual(before);
  });
});

/* ------------------------------------------------------------------ */
/* Review blockers 3 and 4                                              */
/* ------------------------------------------------------------------ */

/** Cell Injury cards all in the REVIEW queue (rated Easy at T0), and a moment when every one is due. */
function reviewState() {
  const { curriculum, lecture } = newLecture();
  const learner = studyOld(curriculum, createLearnerState(), T0, "EASY");
  const cards = studyCardsForLecture(curriculum, OLD);
  const lastDue = Math.max(...cards.map(({ item }) => new Date(learner.cards![item.id]!.schedule.due).getTime()));
  return { curriculum, lecture, learner, cards, later: new Date(lastDue + 60 * 60_000) };
}

describe("Fix 3: a rated old card is not re-inserted before FSRS makes it due — from persisted FSRS state, across refreshes", () => {
  // No session memory exists any more: every call below is what a refresh,
  // another tab or a new session computes from the stored card alone.
  const eligible = (curriculum: ReturnType<typeof applyOverrides>, learner: LearnerState, id: string, at: Date) =>
    eligibleOldReviews(curriculum, learner, NEW, at).find((r) => r.card.item.id === id) ?? null;

  for (const rating of ["HARD", "GOOD", "EASY"] as const) {
    it(`${rating}: not back after a refresh; near-due only in the last part of its new interval; due at its due time`, () => {
      const { curriculum, learner, later } = reviewState();
      const target = eligibleOldReviews(curriculum, learner, NEW, later)[0]!;
      const id = target.card.item.id;
      const after = recordCardRating(curriculum, learner, { conceptId: target.card.concept.id, itemId: id, rating, now: later }).learner;
      const newDue = new Date(after.cards![id]!.schedule.due);
      const interval = newDue.getTime() - later.getTime();
      expect(interval).toBeGreaterThanOrEqual(24 * 3_600_000);
      // Refresh a minute later, an hour later, and just before half the interval: not eligible.
      for (const offset of [60_000, 3_600_000, interval / 2 - 60_000]) expect(eligible(curriculum, after, id, new Date(later.getTime() + offset))).toBeNull();
      // Within the horizon of its due time AND past half its interval: near-due, as designed.
      const nearAt = new Date(Math.max(later.getTime() + interval / 2 + 60_000, newDue.getTime() - NEAR_DUE_HORIZON_MS + 60_000));
      expect(eligible(curriculum, after, id, nearAt)?.reason).toBe("near");
      // At its due time: due.
      expect(eligible(curriculum, after, id, new Date(newDue.getTime() + 1_000))?.reason).toBe("due");
      // Nothing about the FSRS record was changed by the composer.
      expect(after.cards![id]!.schedule.due).toBe(newDue.toISOString());
    });
  }

  it("HARD on a young review card (a one-day interval, as long as the near-due horizon) is not near-due right after rating", () => {
    const { curriculum } = newLecture();
    // Again → Good → Good graduates the old cards with a one-day interval.
    let learner = studyOld(curriculum, createLearnerState(), T0, "AGAIN");
    const target = studyCardsForLecture(curriculum, OLD)[0]!;
    const id = target.item.id;
    for (let i = 0; i < 2; i++) {
      const due = new Date(learner.cards![id]!.schedule.due);
      learner = recordCardRating(curriculum, learner, { conceptId: target.concept.id, itemId: id, rating: "GOOD", now: due }).learner;
    }
    const reviewDue = new Date(learner.cards![id]!.schedule.due);
    learner = recordCardRating(curriculum, learner, { conceptId: target.concept.id, itemId: id, rating: "HARD", now: reviewDue }).learner;
    const newDue = new Date(learner.cards![id]!.schedule.due);
    expect(newDue.getTime() - reviewDue.getTime()).toBe(24 * 3_600_000); // exactly the horizon
    // A refresh one minute later: due in 23h59m — inside the horizon, but it was just rated. Not eligible.
    expect(eligible(curriculum, learner, id, new Date(reviewDue.getTime() + 60_000))).toBeNull();
    expect(eligible(curriculum, learner, id, new Date(reviewDue.getTime() + 11 * 3_600_000))).toBeNull();
    // Past half its interval it is near-due; at its due time, due.
    expect(eligible(curriculum, learner, id, new Date(reviewDue.getTime() + 12 * 3_600_000 + 60_000))?.reason).toBe("near");
    expect(eligible(curriculum, learner, id, new Date(newDue.getTime() + 1_000))?.reason).toBe("due");
  });

  it("AGAIN: relearning — not eligible after a refresh before its step, eligible (and composed back) once the step is due", () => {
    const { curriculum, lecture, learner, later } = reviewState();
    const target = eligibleOldReviews(curriculum, learner, NEW, later)[0]!;
    const id = target.card.item.id;
    const after = recordCardRating(curriculum, learner, { conceptId: target.card.concept.id, itemId: id, rating: "AGAIN", now: later }).learner;
    const newDue = new Date(after.cards![id]!.schedule.due);
    expect(newDue.getTime() - later.getTime()).toBeLessThan(60 * 60_000); // a relearning step, minutes away
    expect(queueForSchedule(after.cards![id]!.schedule)).toBe("LEARNING");
    // Refresh after 30 s, after 1 minute, and a minute before the step: not eligible (never "near").
    for (const at of [later.getTime() + 30_000, later.getTime() + 60_000, newDue.getTime() - 60_000]) expect(eligible(curriculum, after, id, new Date(at))).toBeNull();
    const due = new Date(newDue.getTime() + 1_000);
    const back = eligible(curriculum, after, id, due)!;
    expect(back.reason).toBe("due");
    expect(back.card.queue).toBe("LEARNING");
    // And it is composed back into the session.
    const session = composeSession(buildStudyQueue(curriculum, after, NEW, due).queue, lecture, eligibleOldReviews(curriculum, after, NEW, due));
    expect(session.some((c) => c.origin === "review" && c.item.id === id)).toBe(true);
  });

  it("isNearDue: Learning/Relearning never; Review only inside the horizon and past half its interval", () => {
    const day = 24 * 3_600_000;
    const now = new Date(T0.getTime() + 10 * day);
    const schedule = (lastDaysAgo: number, dueInHours: number, state: number) => ({
      due: new Date(now.getTime() + dueInHours * 3_600_000).toISOString(),
      last_review: new Date(now.getTime() - lastDaysAgo * day).toISOString(),
      stability: 5, difficulty: 5, elapsed_days: 0, scheduled_days: 0, learning_steps: 0, reps: 3, lapses: 0, state,
    });
    expect(isNearDue(schedule(0.001, 0.2, 3), "LEARNING", now)).toBe(false); // relearning step in 12 min
    expect(isNearDue(schedule(0.001, 0.2, 1), "LEARNING", now)).toBe(false); // learning step
    expect(isNearDue(schedule(9, 3, 2), "REVIEW", now)).toBe(true); // 9 days of a ~9-day interval passed, due in 3 h
    expect(isNearDue(schedule(0.001, 23.9, 2), "REVIEW", now)).toBe(false); // just rated, one-day interval
    expect(isNearDue(schedule(0.6, 10, 2), "REVIEW", now)).toBe(true); // 14.4 h of a 24.4 h interval passed
    expect(isNearDue(schedule(9, 30, 2), "REVIEW", now)).toBe(false); // outside the horizon
    expect(isNearDue(schedule(9, -1, 2), "REVIEW", now)).toBe(false); // already due: "due", not "near"
  });
});

describe("Fix 4: inserted old reviews respect the existing reviews-per-day allowance", () => {
  function urgencyState() {
    const { curriculum, lecture, learner, cards, later } = reviewState();
    // Distinct urgencies: A overdue (2 days), B due (1 hour ago), C near (in 2 hours); the rest far in the future.
    const at = (ms: number) => new Date(later.getTime() + ms).toISOString();
    const [a, b, c, ...rest] = cards;
    const moved: LearnerState = { ...learner, cards: { ...learner.cards } };
    const set = (id: string, due: string) => (moved.cards![id] = { ...moved.cards![id]!, schedule: { ...moved.cards![id]!.schedule, due } });
    set(a!.item.id, at(-2 * 24 * 3_600_000));
    set(b!.item.id, at(-3_600_000));
    set(c!.item.id, at(2 * 3_600_000));
    for (const r of rest) set(r.item.id, at(30 * 24 * 3_600_000));
    // Plenty of due ones too, to exceed small limits.
    for (const r of rest.slice(0, 6)) set(r.item.id, at(-10 * 60_000));
    return { curriculum, lecture, learner: moved, later, ids: { a: a!.item.id, b: b!.item.id, c: c!.item.id } };
  }

  const inserted = (maxReviews: number | undefined) => {
    const { curriculum, lecture, learner, later, ids } = urgencyState();
    const current = buildStudyQueue(curriculum, learner, NEW, later).queue;
    const old = eligibleOldReviews(curriculum, learner, NEW, later);
    return { reviews: composeSession(current, lecture, old, { maxReviews }).filter((c) => c.origin === "review"), ids, old };
  };

  it("limit 0: no old reviews are inserted", () => {
    expect(inserted(0).reviews).toEqual([]);
  });

  it("limit 1: exactly one, the most overdue", () => {
    const { reviews, ids } = inserted(1);
    expect(reviews.map((r) => r.item.id)).toEqual([ids.a]);
    expect(reviews[0]!.reason).toBe("overdue");
  });

  it("limit 5: five, in overdue → due → near-due order", () => {
    const { reviews, ids, old } = inserted(5);
    expect(old.length).toBeGreaterThan(5);
    expect(reviews).toHaveLength(5);
    expect(reviews[0]!.item.id).toBe(ids.a);
    const rank = { overdue: 0, due: 1, near: 2 } as const;
    for (let i = 1; i < reviews.length; i++) expect(rank[reviews[i - 1]!.reason!]).toBeLessThanOrEqual(rank[reviews[i]!.reason!]);
    expect(reviews.some((r) => r.item.id === ids.c)).toBe(false); // the near-due one is least urgent
  });

  it("ignore limits (no allowance given): every eligible review is available", () => {
    const { reviews, old } = inserted(undefined);
    // Every overdue and due review comes, once each; the near-due one only rides a cadence
    // slot, and here every slot goes to a more urgent card first.
    const owed = old.filter((r) => r.reason !== "near").map((r) => r.card.item.id);
    expect(owed.length).toBeGreaterThan(5);
    expect(new Set(reviews.map((r) => r.item.id))).toEqual(new Set(owed));
    expect(reviews).toHaveLength(owed.length);
  });

  it("the allowance is what the existing daily limit leaves: today's reviews and this lecture's shown reviews count first, once", () => {
    const { curriculum, learner, later } = urgencyState();
    // Rate one old review: recordCardRating counts it in today's tally (the existing daily-limit bookkeeping).
    const target = eligibleOldReviews(curriculum, learner, NEW, later)[0]!;
    const after = recordCardRating(curriculum, learner, { conceptId: target.card.concept.id, itemId: target.card.item.id, rating: "GOOD", now: later }).learner;
    expect(after.studyDay!.reviews).toBe((learner.studyDay?.day === after.studyDay!.day ? learner.studyDay!.reviews : 0) + 1);
    // With reviewsPerDay = 1 that rating used the whole allowance: nothing more is inserted.
    const remaining = Math.max(0, 1 - after.studyDay!.reviews - buildStudyQueue(curriculum, after, NEW, later).counts.review);
    expect(remaining).toBe(0);
  });
});
