import { describe, expect, it, vi, beforeEach } from "vitest";
import { Rating } from "ts-fsrs";
import { pathologyCurriculum } from "@/lib/content/pathology";
import {
  buildStudyQueue,
  captureCardPrecondition,
  LEARN_AHEAD_MS,
  recordCardRating,
  studyCardsForLecture,
} from "@/lib/engine/study";
import { createLearnerState, getConcept, getItem, recordAttempt } from "@/lib/engine/tutor";
import { FSRS_RATING, previewRatings, ratingFor } from "@/lib/engine/scheduler";
import { applySelfRatingToMastery, createProgress } from "@/lib/domain/mastery";
import { ConceptNotActiveError, ItemConceptMismatchError, StaleAttemptError } from "@/lib/domain/errors";
import { sanitizeLearnerState } from "@/lib/persistence/localStorage";
import { quarantineLegacyLearnerState } from "@/lib/domain/quarantine";
import type { Concept, Curriculum, LearnerState, SelfRating } from "@/lib/domain/types";

// Watch every FSRS call the study path makes.
const fsrsCalls = vi.hoisted(() => ({ ratings: [] as number[] }));
vi.mock("ts-fsrs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ts-fsrs")>();
  return {
    ...actual,
    fsrs: (...args: Parameters<typeof actual.fsrs>) => {
      const engine = actual.fsrs(...args);
      const next = engine.next.bind(engine) as (...a: unknown[]) => unknown;
      engine.next = ((...a: unknown[]) => {
        fsrsCalls.ratings.push(a[2] as number);
        return next(...a);
      }) as typeof engine.next;
      return engine;
    },
  };
});

const L1 = "lecture-cell-injury";
const T0 = new Date("2026-04-01T09:00:00.000Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);
const days = (n: number) => new Date(T0.getTime() + n * 86_400_000);

const ATP = getConcept(pathologyCurriculum, "c-atp-depletion");
const ATP1 = getItem(ATP, "c-atp-1");

function rate(learner: LearnerState, rating: SelfRating, now: Date, concept: Concept = ATP, itemId = ATP1.id, curriculum: Curriculum = pathologyCurriculum) {
  return recordCardRating(curriculum, learner, { conceptId: concept.id, itemId, rating, now });
}

function withStatus(id: string, status: Concept["status"]): Curriculum {
  return {
    ...pathologyCurriculum,
    concepts: pathologyCurriculum.concepts.map((c) => (c.id === id ? { ...c, status } : c)),
  };
}

beforeEach(() => {
  fsrsCalls.ratings.length = 0;
});

describe("the study queue admits ACTIVE cards only", () => {
  it("ACTIVE concepts' retrieval items become cards; DRAFT never does", () => {
    const cards = studyCardsForLecture(pathologyCurriculum, L1);
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every(({ concept }) => concept.status === "ACTIVE")).toBe(true);
    expect(cards.some(({ concept }) => concept.id === "c-draft-lysosomal")).toBe(false);
    for (const { concept, item } of cards) expect(item.conceptId).toBe(concept.id);
    const active = pathologyCurriculum.concepts.filter((c) => c.lectureId === L1 && c.status === "ACTIVE");
    expect(cards.length).toBe(active.reduce((n, c) => n + c.retrievalItems.length, 0));
  });

  it("DISCARDED concepts are excluded", () => {
    const cards = studyCardsForLecture(withStatus(ATP.id, "DISCARDED"), L1);
    expect(cards.some(({ concept }) => concept.id === ATP.id)).toBe(false);
  });

  it("a concept returned to DRAFT leaves the queue even if it has card history", () => {
    const learner = rate(createLearnerState(), "GOOD", T0).learner;
    const queue = buildStudyQueue(withStatus(ATP.id, "DRAFT"), learner, L1, days(30));
    expect(queue.queue.some((c) => c.concept.id === ATP.id)).toBe(false);
  });

  it("an item that does not belong to its concept is never a card", () => {
    const forged: Curriculum = {
      ...pathologyCurriculum,
      concepts: pathologyCurriculum.concepts.map((c) =>
        c.id === ATP.id ? { ...c, retrievalItems: c.retrievalItems.map((i) => ({ ...i, conceptId: "c-hypoxia" })) } : c,
      ),
    };
    expect(studyCardsForLecture(forged, L1).some(({ concept }) => concept.id === ATP.id)).toBe(false);
  });

  it("siblings are not back to back: every concept's first card comes before any second card", () => {
    const cards = studyCardsForLecture(pathologyCurriculum, L1);
    const firstSecond = cards.findIndex(({ concept, item }) => concept.retrievalItems.indexOf(item) === 1);
    const lastFirst = cards.map(({ concept, item }) => concept.retrievalItems.indexOf(item)).lastIndexOf(0);
    expect(lastFirst).toBeLessThan(firstSecond);
  });
});

describe("New / Learning / Review classification and counts", () => {
  it("a fresh learner has only New cards", () => {
    const q = buildStudyQueue(pathologyCurriculum, createLearnerState(), L1, T0);
    expect(q.counts).toEqual({ new: studyCardsForLecture(pathologyCurriculum, L1).length, learning: 0, review: 0 });
    expect(q.next?.queue).toBe("NEW");
  });

  it("Again puts a card in Learning; Easy graduates it to Review", () => {
    let learner = rate(createLearnerState(), "AGAIN", T0).learner;
    let q = buildStudyQueue(pathologyCurriculum, learner, L1, minutes(2));
    expect(q.counts.learning).toBe(1);
    expect(q.queue.find((c) => c.item.id === ATP1.id)?.queue).toBe("LEARNING");

    learner = rate(learner, "EASY", minutes(2)).learner;
    q = buildStudyQueue(pathologyCurriculum, learner, L1, minutes(3));
    expect(q.counts.learning).toBe(0);
    expect(q.queue.some((c) => c.item.id === ATP1.id)).toBe(false); // not due yet
    expect(q.nextDueAt).not.toBeNull();

    const later = buildStudyQueue(pathologyCurriculum, learner, L1, days(60));
    expect(later.counts.review).toBe(1);
    expect(later.queue.find((c) => c.item.id === ATP1.id)?.queue).toBe("REVIEW");
  });

  it("counts are exactly derived from learner and FSRS state", () => {
    let learner = createLearnerState();
    const cards = studyCardsForLecture(pathologyCurriculum, L1);
    learner = rate(learner, "EASY", T0, cards[0]!.concept, cards[0]!.item.id).learner; // → review later
    learner = rate(learner, "AGAIN", T0, cards[1]!.concept, cards[1]!.item.id).learner; // → learning
    const at = days(30);
    const q = buildStudyQueue(pathologyCurriculum, learner, L1, at);
    expect(q.counts).toEqual({ new: cards.length - 2, learning: 1, review: 1 });
    expect(q.queue).toHaveLength(cards.length);
  });

  it("due reviews and due learning come before new cards", () => {
    let learner = createLearnerState();
    const cards = studyCardsForLecture(pathologyCurriculum, L1);
    const last = cards[cards.length - 1]!;
    learner = rate(learner, "EASY", T0, last.concept, last.item.id).learner;
    const q = buildStudyQueue(pathologyCurriculum, learner, L1, days(60));
    expect(q.next?.item.id).toBe(last.item.id);
    expect(q.next?.queue).toBe("REVIEW");
    const firstNew = q.queue.findIndex((c) => c.queue === "NEW");
    const lastReview = q.queue.map((c) => c.queue).lastIndexOf("REVIEW");
    expect(lastReview).toBeLessThan(firstNew);
  });

  it("a learning card due within the learn-ahead window is shown once nothing else is left", () => {
    const only: Curriculum = {
      ...pathologyCurriculum,
      concepts: pathologyCurriculum.concepts.map((c) =>
        c.lectureId === L1 && c.id !== ATP.id ? { ...c, status: "DRAFT" } : c,
      ),
    };
    let learner = createLearnerState();
    for (const item of ATP.retrievalItems.slice(1)) learner = rate(learner, "EASY", T0, ATP, item.id, only).learner;
    learner = rate(learner, "AGAIN", T0, ATP, ATP1.id, only).learner;
    const q = buildStudyQueue(only, learner, L1, T0); // due in 1 minute, not yet due
    expect(q.next?.item.id).toBe(ATP1.id);
    expect(q.counts.learning).toBe(1);
    const beyond = buildStudyQueue(only, learner, L1, new Date(T0.getTime() - LEARN_AHEAD_MS - 60_000));
    expect(beyond.queue.some((c) => c.item.id === ATP1.id)).toBe(false);
  });
});

describe("FSRS receives the learner's exact rating", () => {
  const expected: Record<SelfRating, number> = { AGAIN: Rating.Again, HARD: Rating.Hard, GOOD: Rating.Good, EASY: Rating.Easy };

  for (const rating of ["AGAIN", "HARD", "GOOD", "EASY"] as const) {
    it(`${rating} → FSRS ${Rating[expected[rating]]}, exactly once`, () => {
      rate(createLearnerState(), rating, T0);
      expect(fsrsCalls.ratings).toEqual([expected[rating]]);
      expect(FSRS_RATING[rating]).toBe(expected[rating]);
    });
  }

  it("Easy is not silently mapped to Good", () => {
    const easy = rate(createLearnerState(), "EASY", T0).card.schedule;
    const good = rate(createLearnerState(), "GOOD", T0).card.schedule;
    expect(easy).not.toEqual(good);
    expect(new Date(easy.due).getTime()).toBeGreaterThan(new Date(good.due).getTime());
    expect(FSRS_RATING.EASY).not.toBe(FSRS_RATING.GOOD);
  });

  it("the existing graded-answer path is unchanged: it never produces Easy", () => {
    for (const correct of [true, false]) for (const ctx of ["INITIAL", "IMMEDIATE_REMEDIATION", "SPACED", "INTERLEAVED"] as const)
      expect(ratingFor(correct, ctx)).not.toBe(Rating.Easy);
  });

  it("previews are pure and match what each rating then does", () => {
    const learner = createLearnerState();
    const preview = previewRatings(rate(learner, "GOOD", T0).card.schedule, minutes(15));
    expect(fsrsCalls.ratings).toEqual([Rating.Good]); // preview made no next() call
    const after = rate(learner, "GOOD", T0).learner;
    for (const rating of ["AGAIN", "HARD", "GOOD", "EASY"] as const) {
      const r = recordCardRating(pathologyCurriculum, after, { conceptId: ATP.id, itemId: ATP1.id, rating, now: minutes(15) });
      expect(new Date(r.card.schedule.due).getTime()).toBe(preview[rating].getTime());
    }
  });
});

describe("one rating is one transition", () => {
  it("records exactly one card review and one concept attempt; the input is untouched", () => {
    const learner = createLearnerState();
    const before = structuredClone(learner);
    const { learner: after, card } = rate(learner, "GOOD", T0);
    expect(learner).toEqual(before);
    expect(card.reviews).toBe(1);
    expect(card.lastRating).toBe("GOOD");
    expect(after.cards?.[ATP1.id]).toEqual(card);
    expect(after.progress[ATP.id]!.totalAttempts).toBe(1);
    expect(fsrsCalls.ratings).toHaveLength(1);
  });

  it("a duplicate rating from the same shown card is refused (no double record)", () => {
    const learner = createLearnerState();
    const pre = captureCardPrecondition(learner, ATP, ATP1);
    const first = recordCardRating(pathologyCurriculum, learner, { conceptId: ATP.id, itemId: ATP1.id, rating: "GOOD", now: T0 }, pre);
    expect(() =>
      recordCardRating(pathologyCurriculum, first.learner, { conceptId: ATP.id, itemId: ATP1.id, rating: "GOOD", now: T0 }, pre),
    ).toThrow(StaleAttemptError);
    expect(first.learner.cards?.[ATP1.id]?.reviews).toBe(1);
  });

  it("FSRS is never run backwards", () => {
    const learner = rate(createLearnerState(), "GOOD", minutes(10)).learner;
    expect(() => rate(learner, "GOOD", minutes(5))).toThrow(StaleAttemptError);
  });

  it("refuses DRAFT, DISCARDED, foreign items and unknown ratings without touching state", () => {
    const learner = createLearnerState();
    const draft = getConcept(pathologyCurriculum, "c-draft-lysosomal");
    expect(() => rate(learner, "GOOD", T0, draft, draft.retrievalItems[0]!.id)).toThrow(ConceptNotActiveError);
    expect(() => rate(learner, "GOOD", T0, ATP, ATP1.id, withStatus(ATP.id, "DISCARDED"))).toThrow(ConceptNotActiveError);
    expect(() => rate(learner, "GOOD", T0, ATP, "c-hypoxia-1")).toThrow();
    const forged: Curriculum = {
      ...pathologyCurriculum,
      concepts: pathologyCurriculum.concepts.map((c) =>
        c.id === ATP.id ? { ...c, retrievalItems: c.retrievalItems.map((i) => ({ ...i, conceptId: "c-hypoxia" })) } : c,
      ),
    };
    expect(() => rate(learner, "GOOD", T0, ATP, ATP1.id, forged)).toThrow(ItemConceptMismatchError);
    expect(() => rate(learner, "PERFECT" as SelfRating, T0)).toThrow();
    expect(learner).toEqual(createLearnerState());
    expect(fsrsCalls.ratings).toEqual([]);
  });
});

describe("mastery semantics of self-ratings", () => {
  it("Again marks the concept WEAK and resets the spaced streak", () => {
    const progress = { ...createProgress(ATP.id, rate(createLearnerState(), "GOOD", T0).card.schedule), mastery: "STABLE" as const, consecutiveSpacedSuccesses: 2, totalAttempts: 4, totalCorrect: 4 };
    const after = applySelfRatingToMastery(progress, "AGAIN", "SPACED", T0.toISOString());
    expect(after.mastery).toBe("WEAK");
    expect(after.consecutiveSpacedSuccesses).toBe(0);
    expect(after.totalAttempts).toBe(5);
    expect(after.totalCorrect).toBe(4);
    expect(rate(createLearnerState(), "AGAIN", T0).learner.progress[ATP.id]!.mastery).toBe("WEAK");
  });

  it("Hard never clears WEAK and never advances the spaced streak — in any card state", () => {
    const weak = { ...createProgress(ATP.id, rate(createLearnerState(), "GOOD", T0).card.schedule), mastery: "WEAK" as const, consecutiveSpacedSuccesses: 0, totalAttempts: 1, everWrong: true };
    for (const ctx of ["INITIAL", "IMMEDIATE_REMEDIATION", "SPACED"] as const) {
      const after = applySelfRatingToMastery(weak, "HARD", ctx, T0.toISOString());
      expect(after.mastery, ctx).toBe("WEAK");
      expect(after.consecutiveSpacedSuccesses, ctx).toBe(0);
      expect(after.totalAttempts, ctx).toBe(2);
    }
    const stable = { ...weak, mastery: "STABLE" as const, consecutiveSpacedSuccesses: 2 };
    const hardOnReview = applySelfRatingToMastery(stable, "HARD", "SPACED", T0.toISOString());
    expect(hardOnReview.mastery).toBe("STABLE");
    expect(hardOnReview.consecutiveSpacedSuccesses).toBe(2);
  });

  it("Good/Easy on a card re-shown after Again (Relearning) does NOT clear WEAK — immediate re-study is not recall", () => {
    let learner = rate(createLearnerState(), "EASY", T0).learner; // graduate to Review
    learner = rate(learner, "AGAIN", days(20)).learner; // lapse → Relearning, WEAK
    expect(learner.progress[ATP.id]!.mastery).toBe("WEAK");
    for (const rating of ["GOOD", "EASY"] as const) {
      const after = rate(learner, rating, new Date(days(20).getTime() + 10 * 60_000)).learner;
      expect(after.progress[ATP.id]!.mastery, rating).toBe("WEAK");
      expect(after.progress[ATP.id]!.immediateRemediationPassed).toBe(true);
    }
  });

  it("Good/Easy on a card that came due after an interval is spaced success and climbs the ladder", () => {
    for (const rating of ["GOOD", "EASY"] as const) {
      let learner = rate(createLearnerState(), "EASY", T0).learner; // New → Review
      expect(learner.progress[ATP.id]!.mastery).toBe("LEARNING"); // first exposure, not spaced
      learner = rate(learner, "AGAIN", days(20)).learner;
      learner = rate(learner, "GOOD", new Date(days(20).getTime() + 10 * 60_000)).learner; // relearn, stays WEAK
      const due = new Date(learner.cards![ATP1.id]!.schedule.due);
      learner = rate(learner, rating, new Date(due.getTime() + 1000)).learner; // came due: spaced
      expect(learner.progress[ATP.id]!.mastery, rating).toBe("LEARNING");
      expect(learner.progress[ATP.id]!.consecutiveSpacedSuccesses, rating).toBe(1);
      const due2 = new Date(learner.cards![ATP1.id]!.schedule.due);
      learner = rate(learner, rating, new Date(due2.getTime() + 1000)).learner;
      expect(learner.progress[ATP.id]!.mastery, rating).toBe("STABLE");
    }
  });

  it("Good on a brand-new card is a first exposure: NEW → LEARNING, no spaced credit", () => {
    const p = rate(createLearnerState(), "GOOD", T0).learner.progress[ATP.id]!;
    expect(p.mastery).toBe("LEARNING");
    expect(p.consecutiveSpacedSuccesses).toBe(0);
  });

  it("no mastery percentage is introduced", () => {
    const p = rate(createLearnerState(), "EASY", T0).learner.progress[ATP.id]!;
    expect(["NEW", "LEARNING", "WEAK", "STABLE", "STRONG"]).toContain(p.mastery);
    expect(JSON.stringify(p)).not.toMatch(/percent|score/i);
  });
});

describe("provenance and persistence", () => {
  it("every queued card carries its concept's SourceRef", () => {
    for (const card of buildStudyQueue(pathologyCurriculum, createLearnerState(), L1, T0).queue) {
      expect(card.concept.source).toEqual(getConcept(pathologyCurriculum, card.concept.id).source);
      expect(card.concept.source.pageNumber).toBeGreaterThan(0);
      expect(card.concept.source.excerpt.length).toBeGreaterThan(0);
    }
  });

  it("card progress survives a save/load round trip; malformed cards are dropped singly", () => {
    const learner = rate(createLearnerState(), "HARD", T0).learner;
    const loaded = sanitizeLearnerState(JSON.parse(JSON.stringify(learner)));
    expect(loaded?.state).toEqual(learner);
    const corrupt = JSON.parse(JSON.stringify(learner));
    corrupt.cards.bogus = { itemId: "bogus", conceptId: "x", reviews: -1, lastRating: "MEH", lastReviewedAt: null, schedule: {} };
    const cleaned = sanitizeLearnerState(corrupt);
    expect(cleaned?.state.cards?.[ATP1.id]).toEqual(learner.cards?.[ATP1.id]);
    expect(cleaned?.dropped).toContain("card:bogus");
  });

  it("learner state saved before card study existed loads unchanged", () => {
    const old = recordAttempt(pathologyCurriculum, createLearnerState(), { conceptId: ATP.id, itemId: ATP1.id, answer: "x", context: "INITIAL", now: T0 }).learner;
    const loaded = sanitizeLearnerState(JSON.parse(JSON.stringify(old)));
    expect(loaded?.state).toEqual(old);
    expect("cards" in (loaded?.state ?? {})).toBe(false);
  });

  it("legacy-identity quarantine also removes those concepts' card schedules", () => {
    const legacyDoc = "doc-legacy-12345678";
    const concept: Concept = {
      ...ATP,
      id: `${legacyDoc}-p1-c0`,
      status: "ACTIVE",
      source: { ...ATP.source, documentId: legacyDoc },
      retrievalItems: [{ ...ATP1, id: `${legacyDoc}-p1-c0-r1`, conceptId: `${legacyDoc}-p1-c0` }],
    };
    const learner: LearnerState = {
      ...rate(createLearnerState(), "GOOD", T0).learner,
    };
    learner.cards = {
      ...learner.cards,
      [concept.retrievalItems[0]!.id]: { ...learner.cards![ATP1.id]!, itemId: concept.retrievalItems[0]!.id, conceptId: concept.id },
    };
    const overrides = { version: 4, statusById: {}, edits: {}, lectures: [], ingested: [], concepts: [concept] } as never;
    const result = quarantineLegacyLearnerState(learner, overrides);
    expect(result.changed).toBe(true);
    expect(result.learner.cards?.[concept.retrievalItems[0]!.id]).toBeUndefined();
    expect(result.learner.cards?.[ATP1.id]).toEqual(learner.cards![ATP1.id]);
  });
});
