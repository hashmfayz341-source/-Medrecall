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
