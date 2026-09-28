import { describe, expect, it } from "vitest";
import { pathologyCurriculum as C } from "@/lib/content/pathology";
import { applyOverrides, createOverrides, editCard, setConceptStatus } from "@/lib/domain/curriculum";
import { quarantineLegacyLearnerState } from "@/lib/domain/quarantine";
import type { LearnerState, SelfRating } from "@/lib/domain/types";
import {
  browseCards,
  courseDeck,
  lectureDecks,
  resolveStudySelection,
  selectionFromParams,
  selectionToParams,
} from "@/lib/engine/decks";
import {
  buildStudyQueue,
  buildStudyQueueFor,
  buryCard,
  captureCardPrecondition,
  endOfStudyDay,
  recordCardRating,
  resumeCard,
  studyCardsForCourse,
  studyCardsForLecture,
  studyDayCounts,
  studyDayKey,
  suspendCard,
  unburyCard,
} from "@/lib/engine/study";
import { createLearnerState, getConcept, getNextStep, markChunkTaught, recordAttempt } from "@/lib/engine/tutor";
import { ConceptNotActiveError, StaleAttemptError } from "@/lib/domain/errors";
import {
  LocalStorageLearnerRepository,
  STUDY_CARDS_STORAGE_KEY,
  sanitizeStudyCards,
} from "@/lib/persistence/localStorage";
import { sanitizeStudySettings } from "@/lib/persistence/studySettings";
import { legacyV2Payload } from "./legacy-v2";
import { migrateOverrides } from "@/lib/domain/curriculum";
import { ANSWERS } from "./helpers";

/**
 * Step 2: decks, the card browser, suspend/bury, custom study and daily
 * limits — all derived from Course → Lecture → Concept and the cards' own
 * FSRS state. Concept stays the unit of truth; nothing here stores a deck.
 */

const L1 = "lecture-cell-injury";
const L2 = "lecture-inflammation";
const T0 = new Date("2026-06-01T09:00:00.000Z");
const at = (m: number) => new Date(T0.getTime() + m * 60_000);
const DAY = 60 * 24;

function rate(learner: LearnerState, itemId: string, rating: SelfRating, now: Date, curriculum = C) {
  const concept = curriculum.concepts.find((c) => c.retrievalItems.some((i) => i.id === itemId))!;
  return recordCardRating(curriculum, learner, { conceptId: concept.id, itemId, rating, now }).learner;
}

describe("decks are derived from the curriculum", () => {
  it("one deck per lecture, in course order, holding exactly the studyable cards", () => {
    const decks = lectureDecks(C, createLearnerState(), T0);
    expect(decks.map((d) => d.lecture.id)).toEqual([L1, L2]);
    for (const deck of decks) {
      expect(deck.total).toBe(studyCardsForLecture(C, deck.lecture.id).length);
      expect(deck.counts).toEqual({ new: deck.total, learning: 0, review: 0, suspended: 0, buried: 0 });
    }
    const course = courseDeck(C, createLearnerState(), T0);
    expect(course.total).toBe(studyCardsForCourse(C).length);
    expect(course.counts.new).toBe(course.total);
  });

  it("DRAFT and DISCARDED concepts have no cards in any deck or in the browser; approving adds them at once", () => {
    const fresh = createLearnerState();
    const before = lectureDecks(C, fresh, T0)[0]!.total;
    expect(browseCards(C, fresh, T0).some((r) => r.concept.status !== "ACTIVE")).toBe(false);
    expect(browseCards(C, fresh, T0).some((r) => r.concept.id === "c-draft-lysosomal")).toBe(false);

    const approved = applyOverrides(C, setConceptStatus(createOverrides(), "c-draft-lysosomal", "ACTIVE"));
    expect(lectureDecks(approved, fresh, T0)[0]!.total).toBe(before + 1);
    expect(browseCards(approved, fresh, T0).some((r) => r.concept.id === "c-draft-lysosomal")).toBe(true);

    const discarded = applyOverrides(C, setConceptStatus(createOverrides(), "c-hypoxia", "DISCARDED"));
    expect(lectureDecks(discarded, fresh, T0)[0]!.total).toBe(before - 2);
    expect(browseCards(discarded, fresh, T0).some((r) => r.concept.id === "c-hypoxia")).toBe(false);
  });

  it("counts come from Card FSRS state, not concept mastery", () => {
    // The Tutor makes c-hypoxia WEAK; the deck still shows its cards as New.
    let learner = markChunkTaught(C, createLearnerState(), "chunk-ci-1");
    learner = recordAttempt(C, learner, { conceptId: "c-hypoxia", itemId: "c-hypoxia-1", answer: "no idea", context: "INITIAL", now: T0 }).learner;
    expect(learner.progress["c-hypoxia"]!.mastery).toBe("WEAK");
    const deck = lectureDecks(C, learner, at(1))[0]!;
    expect(deck.counts.new).toBe(deck.total);
    expect(browseCards(C, learner, at(1), { lectureId: L1 }).every((r) => r.status === "NEW")).toBe(true);

    // A Study rating moves the card, and only the card.
    learner = rate(learner, "c-hypoxia-1", "AGAIN", at(2));
    const after = lectureDecks(C, learner, at(3))[0]!;
    expect(after.counts).toEqual({ new: deck.total - 1, learning: 1, review: 0, suspended: 0, buried: 0 });
    expect(browseCards(C, learner, at(3), { status: "LEARNING" }).map((r) => r.item.id)).toEqual(["c-hypoxia-1"]);
  });
});

describe("card browser", () => {
  it("lists every card with concept, lecture, provenance and status, in teaching order", () => {
    const rows = browseCards(C, createLearnerState(), T0);
    expect(rows.length).toBe(studyCardsForCourse(C).length);
    expect(rows.map((r) => r.item.id)).toEqual(studyCardsForCourse(C).map((c) => c.item.id));
    const first = rows[0]!;
    expect(first.lecture.id).toBe(L1);
    expect(first.concept.id).toBe(first.item.conceptId);
    expect(first.document?.id).toBe(first.concept.source.documentId);
    expect(first.status).toBe("NEW");
    expect(first.reviews).toBe(0);
    expect(first.due).toBeNull();
  });

  it("filters by lecture, kind, importance, status, due and text using existing metadata only", () => {
    let learner = rate(createLearnerState(), "c-hypoxia-1", "EASY", T0); // → Review, due in days
    learner = rate(learner, "c-rev-1", "AGAIN", T0); // → Learning, due in a minute
    const later = at(5);
    expect(browseCards(C, learner, later, { lectureId: L2 }).every((r) => r.lecture.id === L2)).toBe(true);
    expect(browseCards(C, learner, later, { kind: "CLOZE" }).every((r) => r.item.kind === "CLOZE")).toBe(true);
    expect(browseCards(C, learner, later, { importance: "CORE" }).every((r) => r.concept.importance === "CORE")).toBe(true);
    expect(browseCards(C, learner, later, { status: "REVIEW" }).map((r) => r.item.id)).toEqual(["c-hypoxia-1"]);
    expect(browseCards(C, learner, later, { status: "DUE" }).map((r) => r.item.id)).toEqual(["c-rev-1"]);
    expect(browseCards(C, learner, later, { text: "HYPOXIA" }).every((r) => /hypoxia/i.test(r.item.prompt + r.item.explanation + r.concept.title))).toBe(true);
    expect(browseCards(C, learner, later, { text: "zzz-nothing" })).toEqual([]);
  });
});

describe("suspend and bury", () => {
  it("suspend removes the card from the queue and counts it; resume brings it back; FSRS history and mastery untouched", () => {
    let learner = rate(createLearnerState(), "c-hypoxia-1", "GOOD", T0);
    const card = learner.cards!["c-hypoxia-1"]!;
    const mastery = learner.progress["c-hypoxia"]!;
    learner = suspendCard(C, learner, "c-hypoxia", "c-hypoxia-1");
    const q = buildStudyQueue(C, learner, L1, at(15));
    expect(q.queue.some((c) => c.item.id === "c-hypoxia-1")).toBe(false);
    expect(q.counts.suspended).toBe(1);
    expect(q.counts.learning).toBe(0);
    expect(browseCards(C, learner, at(15), { status: "SUSPENDED" }).map((r) => r.item.id)).toEqual(["c-hypoxia-1"]);
    expect(learner.cards!["c-hypoxia-1"]).toEqual(card);
    expect(learner.progress["c-hypoxia"]).toEqual(mastery);

    learner = resumeCard(C, learner, "c-hypoxia", "c-hypoxia-1");
    expect(learner.cardFlags).toEqual({});
    const back = buildStudyQueue(C, learner, L1, at(15));
    expect(back.counts.suspended).toBe(0);
    expect(back.queue.some((c) => c.item.id === "c-hypoxia-1")).toBe(true);
    expect(learner.cards!["c-hypoxia-1"]).toEqual(card); // continues from its schedule
  });

  it("bury hides the card until the next local midnight, deterministically from `now`, then it returns on its own", () => {
    let learner = rate(createLearnerState(), "c-hypoxia-1", "AGAIN", T0);
    learner = buryCard(C, learner, "c-hypoxia", "c-hypoxia-1", at(1));
    const until = new Date(learner.cardFlags!["c-hypoxia-1"]!.buriedUntil!);
    expect(until).toEqual(endOfStudyDay(at(1)));
    expect(until.getTime()).toBeGreaterThan(at(1).getTime());

    const during = new Date(until.getTime() - 1);
    expect(buildStudyQueue(C, learner, L1, during).counts.buried).toBe(1);
    expect(buildStudyQueue(C, learner, L1, during).queue.some((c) => c.item.id === "c-hypoxia-1")).toBe(false);
    expect(browseCards(C, learner, during, { status: "BURIED" }).map((r) => r.item.id)).toEqual(["c-hypoxia-1"]);

    const afterward = new Date(until.getTime());
    const q = buildStudyQueue(C, learner, L1, afterward);
    expect(q.counts.buried).toBe(0);
    expect(q.queue[0]?.item.id).toBe("c-hypoxia-1"); // still Learning, due long ago
    expect(learner.cards!["c-hypoxia-1"]!.reviews).toBe(1);

    learner = unburyCard(C, learner, "c-hypoxia", "c-hypoxia-1");
    expect(learner.cardFlags).toEqual({});
    expect(buildStudyQueue(C, learner, L1, during).counts.buried).toBe(0);
  });

  it("suspend and bury are distinct: a suspended card stays out past midnight; bury does not suspend", () => {
    let learner = suspendCard(C, createLearnerState(), "c-hypoxia", "c-hypoxia-1");
    learner = buryCard(C, learner, "c-hypoxia", "c-hypoxia-2", T0);
    const nextDay = new Date(endOfStudyDay(T0).getTime() + 1);
    expect(browseCards(C, learner, nextDay, { status: "SUSPENDED" }).map((r) => r.item.id)).toEqual(["c-hypoxia-1"]);
    expect(browseCards(C, learner, nextDay, { status: "BURIED" })).toEqual([]);
    expect(buildStudyQueue(C, learner, L1, nextDay).counts).toMatchObject({ suspended: 1, buried: 0 });
  });

  it("a flag set before any card was rated is persisted (the sidecar is written for any Study state)", () => {
    const store = new Map<string, string>();
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    };
    try {
      const learner = suspendCard(C, createLearnerState(), "c-hypoxia", "c-hypoxia-1");
      expect(learner.cards).toBeUndefined();
      const repo = new LocalStorageLearnerRepository();
      expect(repo.save(learner)).toBe(true);
      expect(store.has(STUDY_CARDS_STORAGE_KEY)).toBe(true);
      const back = repo.load()!;
      expect(back.cardFlags).toEqual(learner.cardFlags);
      expect(buildStudyQueue(C, back, L1, T0).counts.suspended).toBe(1);
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  it("flags are gated like everything else: a DRAFT card cannot be suspended or buried", () => {
    expect(() => suspendCard(C, createLearnerState(), "c-draft-lysosomal", "c-draft-lyso-1")).toThrow(ConceptNotActiveError);
    expect(() => buryCard(C, createLearnerState(), "c-draft-lysosomal", "c-draft-lyso-1", T0)).toThrow(ConceptNotActiveError);
  });

  it("flags persist in the Study sidecar, never the envelope, and survive a round trip; quarantine strips them with their concept", () => {
    const store = new Map<string, string>();
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    };
    try {
      let learner = rate(createLearnerState(), "c-hypoxia-1", "GOOD", T0);
      learner = suspendCard(C, learner, "c-hypoxia", "c-hypoxia-1");
      learner = buryCard(C, learner, "c-reversible-irreversible", "c-rev-1", T0);
      const repo = new LocalStorageLearnerRepository();
      expect(repo.save(learner)).toBe(true);
      expect(JSON.parse(store.get("medrecall.learner.v1")!).cardFlags).toBeUndefined();
      expect(JSON.parse(store.get("medrecall.learner.v1")!).studyDay).toBeUndefined();
      const side = JSON.parse(store.get(STUDY_CARDS_STORAGE_KEY)!);
      expect(side.flags).toEqual(learner.cardFlags);
      expect(side.studyDay).toEqual(learner.studyDay);
      expect(new LocalStorageLearnerRepository().load()).toEqual(learner);

      // Malformed flags are dropped one by one.
      side.flags["c-hypoxia-2"] = { conceptId: "c-hypoxia", suspended: "yes" };
      const cleaned = sanitizeStudyCards(side)!;
      expect(cleaned.dropped).toEqual(["flags:c-hypoxia-2"]);
      expect(Object.keys(cleaned.flags!).sort()).toEqual(["c-hypoxia-1", "c-rev-1"]);
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }

    // Quarantine: a flag on a card of an untrusted concept goes with the concept.
    const overrides = migrateOverrides(legacyV2Payload({ "legacy-c0": "ACTIVE" }))!;
    const flagged: LearnerState = {
      ...createLearnerState(),
      cardFlags: {
        "legacy-c0-r1": { conceptId: "legacy-c0", suspended: true },
        "c-hypoxia-1": { conceptId: "c-hypoxia", suspended: true },
      },
    };
    const result = quarantineLegacyLearnerState(flagged, overrides);
    expect(result.changed).toBe(true);
    expect(result.learner.cardFlags).toEqual({ "c-hypoxia-1": { conceptId: "c-hypoxia", suspended: true } });
  });
});

describe("custom study", () => {
  it("selects due cards across the course with normal FSRS; new cards are left out", () => {
    let learner = rate(createLearnerState(), "c-hypoxia-1", "AGAIN", T0); // L1, Learning
    learner = rate(learner, "c-signs-1", "AGAIN", T0); // L2, Learning
    const q = buildStudyQueueFor(C, learner, studyCardsForCourse(C), at(2), { dueOnly: true });
    expect(q.queue.map((c) => c.item.id).sort()).toEqual(["c-hypoxia-1", "c-signs-1"]);
    expect(q.counts.new).toBe(0);
    // Rating from a custom queue is the same engine: one FSRS transition, mastery updated.
    const before = learner.cards!["c-hypoxia-1"]!;
    const rated = recordCardRating(C, learner, { conceptId: "c-hypoxia", itemId: "c-hypoxia-1", rating: "GOOD", now: at(2) }).learner;
    expect(rated.cards!["c-hypoxia-1"]!.reviews).toBe(before.reviews + 1);
    expect(rated.cards!["c-hypoxia-1"]).toEqual(rate(learner, "c-hypoxia-1", "GOOD", at(2)).cards!["c-hypoxia-1"]);
  });

  it("a selection over the browser's filters studies exactly those cards", () => {
    const rows = browseCards(C, createLearnerState(), T0, { kind: "CLOZE", lectureId: L1 });
    const q = buildStudyQueueFor(C, createLearnerState(), rows.map((r) => ({ concept: r.concept, item: r.item })), T0);
    expect(q.queue.every((c) => c.item.kind === "CLOZE" && c.concept.lectureId === L1)).toBe(true);
    expect(q.counts.new).toBe(rows.length);
  });
});

describe("study selections", () => {
  it("resolve to the same cards the deck and browser show, and round-trip through URL params", () => {
    const learner = rate(createLearnerState(), "c-hypoxia-1", "AGAIN", T0);
    const lecture = resolveStudySelection(C, learner, at(1), { kind: "lecture", lectureId: L1 });
    expect(lecture.lecture?.id).toBe(L1);
    expect(lecture.cards).toEqual(studyCardsForLecture(C, L1));
    expect(lecture.dueOnly).toBe(false);
    expect(resolveStudySelection(C, learner, at(1), { kind: "lecture", lectureId: "nope" }).lecture).toBeNull();

    const due = resolveStudySelection(C, learner, at(1), { kind: "due" });
    expect(due.cards).toEqual(studyCardsForCourse(C));
    expect(due.dueOnly).toBe(true);

    const filtered = resolveStudySelection(C, learner, at(1), { kind: "filter", filter: { lectureId: L1, kind: "CLOZE" } });
    expect(filtered.cards.map((c) => c.item.id)).toEqual(browseCards(C, learner, at(1), { lectureId: L1, kind: "CLOZE" }).map((r) => r.item.id));

    for (const selection of [
      { kind: "due" } as const,
      { kind: "lecture", lectureId: L2 } as const,
      { kind: "filter", filter: { lectureId: L1, kind: "CLOZE", importance: "CORE", status: "DUE", text: "atp" } } as const,
    ]) {
      const params = selectionToParams(selection, true);
      expect(params.get("ignoreLimits")).toBe("1");
      const back = selectionFromParams(params);
      if (selection.kind === "lecture") expect(back).toEqual({ kind: "filter", filter: { lectureId: L2 } });
      else expect(back).toEqual(selection);
    }
    expect(selectionFromParams(new URLSearchParams())).toEqual({ kind: "filter", filter: {} });
  });
});

describe("daily limits", () => {
  it("today's tally counts first ratings as new and Review-queue ratings as reviews, and resets on a new day", () => {
    let learner = rate(createLearnerState(), "c-hypoxia-1", "EASY", T0); // new → Review
    expect(studyDayCounts(learner, T0)).toEqual({ day: studyDayKey(T0), newIntroduced: 1, reviews: 0 });
    learner = rate(learner, "c-rev-1", "AGAIN", at(1)); // new → Learning
    learner = rate(learner, "c-rev-1", "GOOD", at(2)); // Learning step: neither
    expect(studyDayCounts(learner, at(2))).toMatchObject({ newIntroduced: 2, reviews: 0 });
    const tomorrow = at(DAY + 60);
    expect(studyDayCounts(learner, tomorrow)).toEqual({ day: studyDayKey(tomorrow), newIntroduced: 0, reviews: 0 });
    learner = rate(learner, "c-hypoxia-1", "GOOD", at(10 * DAY)); // Review-queue card rated → review
    expect(studyDayCounts(learner, at(10 * DAY))).toMatchObject({ newIntroduced: 0, reviews: 1 });
  });

  it("new cards beyond the remaining daily allowance are held back; learning cards never are; custom study can ignore limits", () => {
    let learner = createLearnerState();
    const total = studyCardsForLecture(C, L1).length;
    const limits = { newPerDay: 2, reviewsPerDay: 200 };
    let q = buildStudyQueue(C, learner, L1, T0, { limits });
    expect(q.counts.new).toBe(2);
    expect(q.heldByLimits.new).toBe(total - 2);
    learner = rate(learner, q.queue[0]!.item.id, "AGAIN", T0);
    learner = rate(learner, q.queue[1]!.item.id, "GOOD", at(1));
    q = buildStudyQueue(C, learner, L1, at(2), { limits });
    expect(q.counts.new).toBe(0);
    expect(q.counts.learning).toBe(2);
    expect(q.queue.map((c) => c.queue)).toEqual(["LEARNING", "LEARNING"]);
    // Without limits everything is available.
    expect(buildStudyQueue(C, learner, L1, at(2)).counts.new).toBe(total - 2);
    expect(buildStudyQueue(C, learner, L1, at(2)).heldByLimits).toEqual({ new: 0, review: 0 });
  });

  it("reviews beyond the daily allowance are held back", () => {
    let learner = createLearnerState();
    for (const id of ["c-hypoxia-1", "c-hypoxia-2", "c-rev-1"]) learner = rate(learner, id, "EASY", T0); // three Review cards
    const later = at(30 * DAY);
    const q = buildStudyQueue(C, learner, L1, later, { limits: { newPerDay: 0, reviewsPerDay: 2 } });
    expect(q.counts.review).toBe(2);
    expect(q.heldByLimits.review).toBe(1);
    expect(q.counts.new).toBe(0);
    learner = rate(learner, q.queue[0]!.item.id, "GOOD", later);
    learner = rate(learner, q.queue[1]!.item.id, "GOOD", later);
    const next = buildStudyQueue(C, learner, L1, new Date(later.getTime() + 1000), { limits: { newPerDay: 0, reviewsPerDay: 2 } });
    expect(next.counts.review).toBe(0);
    expect(next.heldByLimits.review).toBe(1);
  });

  it("settings are validated: whole numbers within range, else the defaults are used", () => {
    expect(sanitizeStudySettings({ version: 1, newPerDay: 15, reviewsPerDay: 100 })).toEqual({ newPerDay: 15, reviewsPerDay: 100 });
    for (const bad of [{ version: 2, newPerDay: 1, reviewsPerDay: 1 }, { version: 1, newPerDay: -1, reviewsPerDay: 1 }, { version: 1, newPerDay: 1.5, reviewsPerDay: 1 }, { version: 1, newPerDay: 10000, reviewsPerDay: 1 }, { version: 1, newPerDay: "5", reviewsPerDay: 1 }, null, []]) {
      expect(sanitizeStudySettings(bad)).toBeNull();
    }
  });
});

describe("card editing", () => {
  it("keeps the card id and its FSRS history; the wording changes; a rating revealed against the old wording is stale", () => {
    const learner = rate(createLearnerState(), "c-hypoxia-1", "GOOD", T0);
    const edited = applyOverrides(C, editCard(createOverrides(), "c-hypoxia-1", { prompt: "What is the commonest cause of cell injury?", explanation: "Hypoxia." }));
    const item = getConcept(edited, "c-hypoxia").retrievalItems.find((i) => i.id === "c-hypoxia-1")!;
    expect(item.prompt).toBe("What is the commonest cause of cell injury?");
    expect(item.explanation).toBe("Hypoxia.");
    expect(item.requiredKeywords).toEqual(getConcept(C, "c-hypoxia").retrievalItems[0]!.requiredKeywords); // grading untouched
    expect(buildStudyQueue(edited, learner, L1, at(15)).queue.find((c) => c.item.id === "c-hypoxia-1")?.progress).toEqual(learner.cards!["c-hypoxia-1"]);

    const stalePre = captureCardPrecondition(learner, getConcept(C, "c-hypoxia"), getConcept(C, "c-hypoxia").retrievalItems[0]!);
    expect(() => recordCardRating(edited, learner, { conceptId: "c-hypoxia", itemId: "c-hypoxia-1", rating: "GOOD", now: at(15) }, stalePre)).toThrow(StaleAttemptError);
    const freshPre = captureCardPrecondition(learner, getConcept(edited, "c-hypoxia"), item);
    expect(recordCardRating(edited, learner, { conceptId: "c-hypoxia", itemId: "c-hypoxia-1", rating: "GOOD", now: at(15) }, freshPre).card.reviews).toBe(2);
  });

  it("blank edits change nothing; editing never changes status, so a DRAFT card stays out of Study", () => {
    const blank = applyOverrides(C, editCard(createOverrides(), "c-hypoxia-1", { prompt: "   " }));
    expect(getConcept(blank, "c-hypoxia").retrievalItems[0]).toEqual(getConcept(C, "c-hypoxia").retrievalItems[0]);
    const draftEdited = applyOverrides(C, editCard(createOverrides(), "c-draft-lyso-1", { prompt: "Edited draft prompt" }));
    expect(getConcept(draftEdited, "c-draft-lysosomal").status).toBe("DRAFT");
    expect(studyCardsForCourse(draftEdited).some((c) => c.item.id === "c-draft-lyso-1")).toBe(false);
    expect(getNextStep(draftEdited, createLearnerState(), L1, T0).kind).toBe("TEACH");
  });

  it("the Tutor asks the edited wording too (one card, one truth), and grading is unchanged", () => {
    const edited = applyOverrides(C, editCard(createOverrides(), "c-hypoxia-1", { prompt: "Edited prompt?" }));
    const learner = markChunkTaught(edited, createLearnerState(), "chunk-ci-1");
    const step = getNextStep(edited, learner, L1, T0);
    expect(step.kind).toBe("RETRIEVE");
    if (step.kind === "RETRIEVE") {
      expect(step.item.prompt).toBe("Edited prompt?");
      const result = recordAttempt(edited, learner, { conceptId: "c-hypoxia", itemId: step.item.id, answer: ANSWERS["c-hypoxia"]!, context: "INITIAL", now: T0 });
      expect(result.grade.correct).toBe(true);
    }
  });

  it("stored card edits are validated; malformed ones reject the store like any other field", () => {
    const ok = migrateOverrides({ version: 4, statusById: {}, cardEdits: { "c-hypoxia-1": { prompt: "x" } } });
    expect(ok?.cardEdits).toEqual({ "c-hypoxia-1": { prompt: "x" } });
    expect(migrateOverrides({ version: 4, statusById: {} })?.cardEdits).toEqual({});
    expect(migrateOverrides({ version: 4, statusById: {}, cardEdits: { "c-hypoxia-1": { prompt: 5 } } })).toBeNull();
    expect(migrateOverrides({ version: 4, statusById: {}, cardEdits: [] })).toBeNull();
  });
});
