import { describe, expect, it } from "vitest";
import { pathologyCurriculum as C } from "@/lib/content/pathology";
import { addLecture, applyOverrides, createOverrides, setConceptStatuses } from "@/lib/domain/curriculum";
import type { Concept, Lecture, LearnerState } from "@/lib/domain/types";
import { buildStudyQueue, buryCard, recordCardRating, studyCardsForLecture, suspendCard } from "@/lib/engine/study";
import { NEAR_DUE_HORIZON_MS, REVIEW_EVERY, composeSession, eligibleOldReviews } from "@/lib/engine/session";
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
    // Nothing is due one minute later: GOOD on a new card schedules a learning step minutes away, but not overdue.
    expect(eligibleOldReviews(curriculum, learner, NEW, new Date(T0.getTime() + 1_000))).not.toEqual([]); // near-due within 24h
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

describe("Fix 3: an old card rated in this session is not re-inserted before FSRS makes it due again", () => {
  for (const rating of ["HARD", "GOOD", "EASY"] as const) {
    it(`${rating}: not back before its new due time — not even as "near-due" — and eligible again once due`, () => {
      const { curriculum, learner, later } = reviewState();
      const target = eligibleOldReviews(curriculum, learner, NEW, later)[0]!;
      const after = recordCardRating(curriculum, learner, { conceptId: target.card.concept.id, itemId: target.card.item.id, rating, now: later }).learner;
      const newDue = new Date(after.cards![target.card.item.id]!.schedule.due);
      expect(newDue.getTime()).toBeGreaterThan(later.getTime());
      const rated = new Set([target.card.item.id]);
      const inSession = (at: Date) => eligibleOldReviews(curriculum, after, NEW, at, { ratedThisSession: rated }).some((r) => r.card.item.id === target.card.item.id);
      // Right after rating, and a minute before the new due time: never.
      expect(inSession(new Date(later.getTime() + 60_000))).toBe(false);
      expect(inSession(new Date(newDue.getTime() - 60_000))).toBe(false);
      // Without session identity, the same card WOULD come back as near-due inside the horizon (the reported bug).
      const nearWindow = new Date(Math.max(later.getTime() + 60_000, newDue.getTime() - NEAR_DUE_HORIZON_MS + 60_000));
      if (nearWindow < newDue) {
        expect(eligibleOldReviews(curriculum, after, NEW, nearWindow).some((r) => r.card.item.id === target.card.item.id && r.reason === "near")).toBe(true);
        expect(inSession(nearWindow)).toBe(false);
      }
      // Once FSRS makes it due, it is eligible again.
      expect(inSession(new Date(newDue.getTime() + 1_000))).toBe(true);
      // Nothing about the FSRS record was changed by the composer.
      expect(after.cards![target.card.item.id]!.schedule.due).toBe(newDue.toISOString());
    });
  }

  it("AGAIN: the card relearns and legitimately comes back in the same session when its relearning step is due", () => {
    const { curriculum, lecture, learner, later } = reviewState();
    const target = eligibleOldReviews(curriculum, learner, NEW, later)[0]!;
    const after = recordCardRating(curriculum, learner, { conceptId: target.card.concept.id, itemId: target.card.item.id, rating: "AGAIN", now: later }).learner;
    const newDue = new Date(after.cards![target.card.item.id]!.schedule.due);
    expect(newDue.getTime() - later.getTime()).toBeLessThan(60 * 60_000); // a relearning step, minutes away
    const rated = new Set([target.card.item.id]);
    expect(eligibleOldReviews(curriculum, after, NEW, new Date(later.getTime() + 30_000), { ratedThisSession: rated }).some((r) => r.card.item.id === target.card.item.id)).toBe(false);
    const due = new Date(newDue.getTime() + 1_000);
    const back = eligibleOldReviews(curriculum, after, NEW, due, { ratedThisSession: rated }).find((r) => r.card.item.id === target.card.item.id)!;
    expect(back.reason).toBe("due");
    expect(back.card.queue).toBe("LEARNING");
    // And it is composed back into the session.
    const session = composeSession(buildStudyQueue(curriculum, after, NEW, due).queue, lecture, eligibleOldReviews(curriculum, after, NEW, due, { ratedThisSession: rated }));
    expect(session.some((c) => c.origin === "review" && c.item.id === target.card.item.id)).toBe(true);
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
