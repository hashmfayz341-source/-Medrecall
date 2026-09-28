import { beforeEach, describe, expect, it, vi } from "vitest";
import { pathologyCurriculum } from "@/lib/content/pathology";
import {
  captureCardPrecondition,
  recordCardRating,
  studyCardsForLecture,
} from "@/lib/engine/study";
import {
  createLearnerState,
  getConcept,
  getItem,
  recordAttempt,
  selectInterleavedConcept,
} from "@/lib/engine/tutor";
import { buildTodayQueue, scoreConcept } from "@/lib/engine/priority";
import { isDue } from "@/lib/engine/scheduler";
import { applyOverrides, createOverrides, editConcept } from "@/lib/domain/curriculum";
import { ConceptNotActiveError, StaleAttemptError } from "@/lib/domain/errors";
import type { Concept, Curriculum, LearnerState, RetrievalItem, SelfRating } from "@/lib/domain/types";
import { ANSWERS, WRONG } from "./helpers";
import { driveLecture } from "./driver";

/**
 * Integrity of card study against the rest of the system.
 *
 * H1 — card study must not make a concept look like a due TUTOR review just
 *      because card study created its (never-reviewed) concept schedule.
 * M1 — a rating is for the content the learner saw: if the card's content,
 *      source or status changes after Show Answer, the rating is stale.
 */

const fsrsCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock("ts-fsrs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ts-fsrs")>();
  return {
    ...actual,
    fsrs: (...args: Parameters<typeof actual.fsrs>) => {
      const engine = actual.fsrs(...args);
      const next = engine.next.bind(engine) as (...a: unknown[]) => unknown;
      engine.next = ((...a: unknown[]) => {
        fsrsCalls.n++;
        return next(...a);
      }) as typeof engine.next;
      return engine;
    },
  };
});

const L1 = "lecture-cell-injury";
const L2 = "lecture-inflammation";
const T0 = new Date("2026-05-01T09:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const ATP = getConcept(pathologyCurriculum, "c-atp-depletion");
const ATP1 = getItem(ATP, "c-atp-1");

function rateCard(learner: LearnerState, rating: SelfRating, now: Date, concept = ATP, item: RetrievalItem = ATP1, curriculum: Curriculum = pathologyCurriculum) {
  return recordCardRating(curriculum, learner, { conceptId: concept.id, itemId: item.id, rating, now });
}

const inToday = (learner: LearnerState, now: Date, id = ATP.id) =>
  buildTodayQueue(pathologyCurriculum, learner, now).some((e) => e.concept.id === id);

/** A learner who has completed Lecture 1 in the tutor, so Lecture 2 can interleave. */
function lecture1Done(): LearnerState {
  return driveLecture(createLearnerState(), L1, T0).learner;
}

beforeEach(() => {
  fsrsCalls.n = 0;
});

describe("H1: card study never creates a fake due tutor review", () => {
  for (const rating of ["GOOD", "EASY"] as const) {
    it(`fresh NEW card rated ${rating}: card is scheduled ahead, concept is NOT tutor-due`, () => {
      const { learner, card } = rateCard(createLearnerState(), rating, T0);
      const cardDue = new Date(card.schedule.due);
      expect(cardDue.getTime()).toBeGreaterThan(T0.getTime());

      const progress = learner.progress[ATP.id]!;
      expect(progress.totalAttempts).toBe(1);
      expect(progress.mastery).toBe("LEARNING");

      for (const now of [T0, at(1), at(60 * 24 * 30)]) {
        expect(isDue(progress, now), now.toISOString()).toBe(false);
        expect(inToday(learner, now), now.toISOString()).toBe(false);
      }
      // No due bonus in the priority score either.
      const withDue = scoreConcept(ATP, progress, { now: T0, curriculum: pathologyCurriculum });
      expect(withDue).toBe(ATP.importance === "CORE" ? 100 : 0);
    });

    it(`fresh NEW card rated ${rating}: the concept is not interleaved into a later lecture`, () => {
      const base = lecture1Done();
      // A Lecture 1 concept the tutor has attempted is replaced by card study only:
      // drop its tutor record, then study it as a card.
      const withoutTutor: LearnerState = {
        ...base,
        progress: Object.fromEntries(Object.entries(base.progress).filter(([id]) => id !== ATP.id)),
      };
      const { learner } = rateCard(withoutTutor, rating, T0);
      const firstL2Chunk = pathologyCurriculum.course.lectures.find((l) => l.id === L2)!.chunks[0]!.id;
      for (const now of [T0, at(5)]) {
        const injected = selectInterleavedConcept(pathologyCurriculum, learner, L2, firstL2Chunk, now);
        expect(injected?.id, now.toISOString()).not.toBe(ATP.id);
      }
    });
  }

  it("AGAIN still surfaces the concept through WEAK (Today and interleaving)", () => {
    const { learner } = rateCard(createLearnerState(), "AGAIN", T0);
    expect(learner.progress[ATP.id]!.mastery).toBe("WEAK");
    expect(inToday(learner, T0)).toBe(true);

    const base = lecture1Done();
    const onlyCard: LearnerState = {
      ...base,
      progress: Object.fromEntries(Object.entries(base.progress).filter(([id]) => id !== ATP.id)),
    };
    const weak = rateCard(onlyCard, "AGAIN", T0).learner;
    const firstL2Chunk = pathologyCurriculum.course.lectures.find((l) => l.id === L2)!.chunks[0]!.id;
    const injected = selectInterleavedConcept(pathologyCurriculum, weak, L2, firstL2Chunk, T0);
    expect(injected?.id).toBe(ATP.id);
  });

  it("card study never advances the concept-level (tutor) schedule", () => {
    const tutored = recordAttempt(pathologyCurriculum, createLearnerState(), {
      conceptId: ATP.id, itemId: ATP1.id, answer: ANSWERS[ATP.id]!, context: "INITIAL", now: T0,
    }).learner;
    const scheduleBefore = tutored.progress[ATP.id]!.schedule;
    let learner = tutored;
    for (const rating of ["GOOD", "EASY", "HARD", "AGAIN"] as const) {
      learner = rateCard(learner, rating, at(60 * 24 * 40)).learner;
      expect(learner.progress[ATP.id]!.schedule).toEqual(scheduleBefore);
    }
  });

  it("tutor-scheduled concepts are due exactly as before (reps > 0 schedules unchanged)", () => {
    // Drive both lectures through the tutor with some failures, then check
    // dueness at many times against the plain "due <= now" rule.
    let learner = driveLecture(createLearnerState(), L1, T0, (step, log) =>
      log.some((l) => l.conceptId === step.concept.id) ? (ANSWERS[step.concept.id] ?? WRONG) : step.concept.id === ATP.id ? WRONG : (ANSWERS[step.concept.id] ?? WRONG),
    ).learner;
    learner = driveLecture(learner, L2, at(60 * 24 * 2)).learner;
    const progresses = Object.values(learner.progress);
    expect(progresses.length).toBeGreaterThan(5);
    for (const p of progresses) {
      expect(p.schedule.reps).toBeGreaterThan(0);
      for (const days of [0, 1, 3, 10, 30, 90, 365]) {
        const now = new Date(T0.getTime() + days * 86_400_000);
        expect(isDue(p, now)).toBe(new Date(p.schedule.due).getTime() <= now.getTime());
      }
    }
  });

  it("a concept first studied as a card, then attempted in the tutor, schedules exactly like a tutor-only concept", () => {
    const later = at(60 * 24 * 5);
    const studied = rateCard(createLearnerState(), "GOOD", T0).learner;
    const attempt = { conceptId: ATP.id, itemId: ATP1.id, answer: ANSWERS[ATP.id]!, context: "INITIAL" as const, now: later };
    const afterStudy = recordAttempt(pathologyCurriculum, studied, attempt).learner.progress[ATP.id]!;
    const tutorOnly = recordAttempt(pathologyCurriculum, createLearnerState(), attempt).learner.progress[ATP.id]!;
    expect(afterStudy.schedule).toEqual(tutorOnly.schedule);
    expect(afterStudy.schedule.reps).toBeGreaterThan(0);
    expect(isDue(afterStudy, new Date(afterStudy.schedule.due))).toBe(true);
  });
});

describe("M1: a rating applies only to the content that was shown", () => {
  const change = (f: (c: Concept) => Concept): Curriculum => ({
    ...pathologyCurriculum,
    concepts: pathologyCurriculum.concepts.map((c) => (c.id === ATP.id ? f(c) : c)),
  });
  const changeItem = (f: (i: RetrievalItem) => RetrievalItem) =>
    change((c) => ({ ...c, retrievalItems: c.retrievalItems.map((i) => (i.id === ATP1.id ? f(i) : i)) }));

  const cases: [string, Curriculum, typeof StaleAttemptError | typeof ConceptNotActiveError][] = [
    ["concept title", change((c) => ({ ...c, title: `${c.title} (edited)` })), StaleAttemptError],
    ["concept summary", change((c) => ({ ...c, summary: `${c.summary} Edited.` })), StaleAttemptError],
    ["ACTIVE → DRAFT", change((c) => ({ ...c, status: "DRAFT" })), ConceptNotActiveError],
    ["ACTIVE → DISCARDED", change((c) => ({ ...c, status: "DISCARDED" })), ConceptNotActiveError],
    ["source excerpt", change((c) => ({ ...c, source: { ...c.source, excerpt: `${c.source.excerpt} (corrected)` } })), StaleAttemptError],
    ["source page", change((c) => ({ ...c, source: { ...c.source, pageNumber: c.source.pageNumber + 1 } })), StaleAttemptError],
    ["source document", change((c) => ({ ...c, source: { ...c.source, documentId: "another-document" } })), StaleAttemptError],
    ["item prompt", changeItem((i) => ({ ...i, prompt: `${i.prompt} (revised)` })), StaleAttemptError],
    ["item explanation", changeItem((i) => ({ ...i, explanation: `${i.explanation} (revised)` })), StaleAttemptError],
    ["item kind", changeItem((i) => ({ ...i, kind: i.kind === "CLOZE" ? "BASIC" : "CLOZE" })), StaleAttemptError],
    ["requiredKeywords", changeItem((i) => ({ ...i, requiredKeywords: [...i.requiredKeywords, ["mitochondria"]] })), StaleAttemptError],
    ["acceptableAnswers", changeItem((i) => ({ ...i, acceptableAnswers: [...i.acceptableAnswers, "anything"] })), StaleAttemptError],
  ];

  for (const [name, later, error] of cases) {
    it(`${name} changed after Show Answer → rating refused, zero mutation`, () => {
      // Some history, so "no change" is meaningful for card and concept alike.
      const learner = rateCard(createLearnerState(), "AGAIN", T0).learner;
      const pre = captureCardPrecondition(learner, ATP, ATP1);
      const before = structuredClone(learner);
      fsrsCalls.n = 0;
      expect(() =>
        recordCardRating(later, learner, { conceptId: ATP.id, itemId: ATP1.id, rating: "GOOD", now: at(2) }, pre),
      ).toThrow(error);
      expect(learner).toEqual(before);
      expect(fsrsCalls.n).toBe(0);
    });
  }

  it("unchanged content still records normally with the precondition", () => {
    const learner = createLearnerState();
    const pre = captureCardPrecondition(learner, ATP, ATP1);
    const r = recordCardRating(pathologyCurriculum, learner, { conceptId: ATP.id, itemId: ATP1.id, rating: "GOOD", now: T0 }, pre);
    expect(r.card.reviews).toBe(1);
  });

  it("changes to OTHER concepts do not make this card stale", () => {
    const learner = createLearnerState();
    const pre = captureCardPrecondition(learner, ATP, ATP1);
    const later: Curriculum = {
      ...pathologyCurriculum,
      concepts: pathologyCurriculum.concepts.map((c) => (c.id === "c-hypoxia" ? { ...c, title: "Changed" } : c)),
    };
    expect(recordCardRating(later, learner, { conceptId: ATP.id, itemId: ATP1.id, rating: "GOOD", now: T0 }, pre).card.reviews).toBe(1);
  });
});

describe("card identity across an ordinary human edit", () => {
  it("authored concepts: the first edit rebuilds item ids (c-atp-1 → c-atp-depletion-r1)", () => {
    const edited = applyOverrides(pathologyCurriculum, editConcept(createOverrides(), ATP.id, { title: "ATP depletion (reviewed)" }));
    const ids = getConcept(edited, ATP.id).retrievalItems.map((i) => i.id);
    expect(ATP.retrievalItems.map((i) => i.id)).toEqual(["c-atp-1", "c-atp-2", "c-atp-3"]);
    expect(ids).toEqual([`${ATP.id}-r1`, `${ATP.id}-r2`]);
    // Old card progress no longer matches a card; the rebuilt cards are new.
    const learner = rateCard(createLearnerState(), "EASY", T0).learner;
    const cards = studyCardsForLecture(edited, L1).filter((c) => c.concept.id === ATP.id);
    expect(cards.every((c) => learner.cards?.[c.item.id] === undefined)).toBe(true);
    // Concept mastery (keyed by concept id) is kept.
    expect(learner.progress[ATP.id]).toBeDefined();
  });

  it("ingested-style ids (${conceptId}-rN) are stable across edits, so card progress is preserved", () => {
    const once = applyOverrides(pathologyCurriculum, editConcept(createOverrides(), ATP.id, { title: "First edit" }));
    const twice = applyOverrides(pathologyCurriculum, editConcept(editConcept(createOverrides(), ATP.id, { title: "First edit" }), ATP.id, { summary: "A different reviewed summary." }));
    const a = getConcept(once, ATP.id).retrievalItems.map((i) => i.id);
    const b = getConcept(twice, ATP.id).retrievalItems.map((i) => i.id);
    expect(b).toEqual(a);
    const concept = getConcept(once, ATP.id);
    const learner = recordCardRating(once, createLearnerState(), { conceptId: ATP.id, itemId: a[0]!, rating: "EASY", now: T0 }).learner;
    const card = studyCardsForLecture(twice, L1).find((c) => c.item.id === a[0]);
    expect(card).toBeDefined();
    expect(learner.cards?.[a[0]!]?.reviews).toBe(1);
    // …but a rating in flight across that edit is refused (content changed).
    const pre = captureCardPrecondition(learner, concept, getItem(concept, a[0]!));
    expect(() =>
      recordCardRating(twice, learner, { conceptId: ATP.id, itemId: a[0]!, rating: "GOOD", now: at(60 * 24 * 30) }, pre),
    ).toThrow(StaleAttemptError);
  });
});
