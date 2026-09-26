import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pathologyCurriculum as C } from "@/lib/content/pathology";
import { migrateOverrides } from "@/lib/domain/curriculum";
import { acceptIncomingLearnerState } from "@/lib/domain/quarantine";
import type { CardProgress, LearnerState, SelfRating } from "@/lib/domain/types";
import { buildStudyQueue, recordCardRating } from "@/lib/engine/study";
import {
  createLearnerState,
  getNextStep,
  markChunkTaught,
  pendingRemediation,
  recordAttempt,
} from "@/lib/engine/tutor";
import {
  LocalStorageLearnerRepository,
  STORAGE_KEY,
  STUDY_CARDS_STORAGE_KEY,
  sanitizeStudyCards,
} from "@/lib/persistence/localStorage";
import { openOldMainTab, type OldLearnerState, type OldMainTab } from "../base-main/oldMain";
import { legacyV2Payload } from "./legacy-v2";
import { ANSWERS, WRONG } from "./helpers";

/**
 * Mixed versions: this build and a browser tab still running main@482824c
 * share one origin's localStorage. The old tab is main's REAL code, taken
 * from git (tests/base-main): its repository loads, sanitizes and saves
 * `medrecall.learner.v1` exactly as main does — keeping each concept record
 * as stored, and rebuilding the envelope without anything it does not know
 * (so without `cards`).
 */

const L1 = "lecture-cell-injury";
const CHUNK1 = "chunk-ci-1";
const HYPOXIA = "c-hypoxia";
const REV = "c-reversible-irreversible";
const T0 = new Date("2026-06-01T09:00:00.000Z");
const at = (m: number) => new Date(T0.getTime() + m * 60_000);
const DAY = 60 * 24;

let store: Map<string, string>;
let failWrites: Set<string>;
let old: OldMainTab;

beforeAll(async () => {
  old = await openOldMainTab();
});

beforeEach(() => {
  store = new Map();
  failWrites = new Set();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (failWrites.has(k)) throw new Error("QuotaExceededError");
        store.set(k, v);
      },
      removeItem: (k: string) => void store.delete(k),
    },
  };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

const current = () => new LocalStorageLearnerRepository();
const reload = () => current().load()!;
const flag = (s: LearnerState, id: string) => s.progress[id]?.pendingTutorRemediation;

function tutor(s: LearnerState, conceptId: string, itemId: string, correct: boolean, context: "INITIAL" | "IMMEDIATE_REMEDIATION" | "SPACED" | "INTERLEAVED", now: Date) {
  return recordAttempt(C, s, { conceptId, itemId, answer: correct ? ANSWERS[conceptId]! : WRONG, context, now }).learner;
}
function study(s: LearnerState, itemId: string, rating: SelfRating, now: Date) {
  const concept = C.concepts.find((c) => c.retrievalItems.some((i) => i.id === itemId))!;
  return recordCardRating(C, s, { conceptId: concept.id, itemId, rating, now }).learner;
}

/** The stale main tab loads what is stored, does something, and saves. */
function oldTabDoes(fn: (s: OldLearnerState) => OldLearnerState) {
  const loaded = old.load();
  expect(loaded, "main could load the stored state").not.toBeNull();
  expect(old.save(fn(loaded!))).toBe(true);
}
/** main answers an unrelated concept (REV) in the Tutor. */
const oldAnswersUnrelated = (s: OldLearnerState) =>
  old.answer(s, { conceptId: REV, itemId: "c-rev-1", answer: ANSWERS[REV]!, context: "INITIAL", chunkId: CHUNK1, now: at(30) });

describe("the old writer is main's real code", () => {
  it("main's save drops `cards` and keeps concept records as stored", () => {
    let s = markChunkTaught(C, createLearnerState(), CHUNK1);
    s = study(s, "c-hypoxia-1", "GOOD", T0);
    s = tutor(s, HYPOXIA, "c-hypoxia-1", false, "INITIAL", at(1));
    store.set(STORAGE_KEY, JSON.stringify(s));
    oldTabDoes(oldAnswersUnrelated);
    const written = JSON.parse(store.get(STORAGE_KEY)!);
    expect(written.cards).toBeUndefined();
    expect(written.progress[HYPOXIA]).toEqual(JSON.parse(JSON.stringify(s.progress[HYPOXIA])));
  });
});

describe("Part 1: a pending Tutor remediation survives an old-main write", () => {
  it("A: pending TRUE on hypoxia (Study AGAIN+GOOD after a Tutor failure) → main changes an unrelated concept → still TRUE", () => {
    let s = markChunkTaught(C, createLearnerState(), CHUNK1);
    s = tutor(s, HYPOXIA, "c-hypoxia-1", false, "INITIAL", T0);
    s = study(s, "c-hypoxia-1", "AGAIN", at(1));
    s = study(s, "c-hypoxia-1", "GOOD", at(2));
    expect(flag(s, HYPOXIA)).toBe(true);
    expect(s.progress[HYPOXIA]!.immediateRemediationPassed).toBe(true);
    expect(getNextStep(C, s, L1, at(3)).kind).toBe("REMEDIATE");
    expect(current().save(s)).toBe(true);

    oldTabDoes(oldAnswersUnrelated);

    const back = reload();
    expect(flag(back, HYPOXIA)).toBe(true);
    const step = getNextStep(C, back, L1, at(31));
    expect(step.kind).toBe("REMEDIATE");
    if (step.kind === "REMEDIATE") expect(step.concept.id).toBe(HYPOXIA);
  });

  it("A': plain Tutor failure pending → main changes an unrelated concept → still TRUE", () => {
    let s = markChunkTaught(C, createLearnerState(), CHUNK1);
    s = tutor(s, HYPOXIA, "c-hypoxia-1", false, "INITIAL", T0);
    current().save(s);
    oldTabDoes(oldAnswersUnrelated);
    expect(flag(reload(), HYPOXIA)).toBe(true);
  });

  it("B: pending FALSE on a WEAK concept (Study failure before the Tutor) → main changes an unrelated concept → still FALSE, no extra remediation", () => {
    let s = study(createLearnerState(), "c-hypoxia-1", "AGAIN", T0);
    s = markChunkTaught(C, s, CHUNK1);
    s = tutor(s, HYPOXIA, "c-hypoxia-1", true, "INITIAL", at(2));
    expect(s.progress[HYPOXIA]!.mastery).toBe("WEAK");
    expect(flag(s, HYPOXIA)).toBe(false);
    current().save(s);

    oldTabDoes(oldAnswersUnrelated);

    const back = reload();
    expect(flag(back, HYPOXIA)).toBe(false);
    expect(pendingRemediation(back.progress[HYPOXIA])).toBe(false);
    expect(getNextStep(C, back, L1, at(31)).kind).not.toBe("REMEDIATE");
  });

  it("C: pending TRUE → main performs the remediation on the SAME concept, correctly → not resurrected", () => {
    let s = markChunkTaught(C, createLearnerState(), CHUNK1);
    s = tutor(s, HYPOXIA, "c-hypoxia-1", false, "INITIAL", T0);
    current().save(s);

    oldTabDoes((o) => {
      expect(old.nextStepKind(o, L1, at(1))).toEqual({ kind: "REMEDIATE", conceptId: HYPOXIA });
      return old.answer(o, { conceptId: HYPOXIA, itemId: "c-hypoxia-2", answer: ANSWERS[HYPOXIA]!, context: "IMMEDIATE_REMEDIATION", chunkId: CHUNK1, now: at(1) });
    });

    const back = reload();
    expect(flag(back, HYPOXIA)).toBe(false);
    expect(getNextStep(C, back, L1, at(2)).kind).not.toBe("REMEDIATE");
  });

  it("D: pending FALSE → main records a Tutor failure on the SAME concept → pending recovered", () => {
    for (const start of ["Tutor success", "WEAK from a Study failure"] as const) {
      store.clear();
      let s = start === "Tutor success" ? createLearnerState() : study(createLearnerState(), "c-hypoxia-1", "AGAIN", T0);
      s = markChunkTaught(C, s, CHUNK1);
      s = tutor(s, HYPOXIA, "c-hypoxia-1", true, "INITIAL", at(2));
      expect(flag(s, HYPOXIA), start).toBe(false);
      current().save(s);

      oldTabDoes((o) => old.answer(o, { conceptId: HYPOXIA, itemId: "c-hypoxia-2", answer: WRONG, context: "SPACED", now: at(DAY) }));

      const back = reload();
      expect(flag(back, HYPOXIA), start).toBe(true);
      expect(getNextStep(C, back, L1, at(DAY + 1)).kind, start).toBe("REMEDIATE");
    }
  });

  it("E: state written only by main (never by this build) migrates with main's rule", () => {
    // main creates it from nothing: chunk taught, hypoxia failed.
    let o = old.markChunkTaught({ version: 1, progress: {}, taughtChunkIds: [], completedChunkIds: [], completedLectureIds: [], injectedByChunk: {} }, CHUNK1);
    o = old.answer(o, { conceptId: HYPOXIA, itemId: "c-hypoxia-1", answer: WRONG, context: "INITIAL", chunkId: CHUNK1, now: T0 });
    old.save(o);
    let back = reload();
    expect(flag(back, HYPOXIA)).toBe(true);
    expect(getNextStep(C, back, L1, at(1)).kind).toBe("REMEDIATE");

    oldTabDoes((x) => old.answer(x, { conceptId: HYPOXIA, itemId: "c-hypoxia-2", answer: ANSWERS[HYPOXIA]!, context: "IMMEDIATE_REMEDIATION", chunkId: CHUNK1, now: at(1) }));
    back = reload();
    expect(flag(back, HYPOXIA)).toBe(false);
    expect(getNextStep(C, back, L1, at(2)).kind).toBe("RETRIEVE");
  });

  it("F: this build → this build preserves the exact explicit state (flags, stamps, cards)", () => {
    let s = study(createLearnerState(), "c-hypoxia-1", "AGAIN", T0);
    s = markChunkTaught(C, s, CHUNK1);
    s = tutor(s, HYPOXIA, "c-hypoxia-1", true, "INITIAL", at(2)); // WEAK, not pending
    s = tutor(s, REV, "c-rev-1", false, "INITIAL", at(3)); // pending
    s = study(s, "c-rev-2", "AGAIN", at(4));
    s = study(s, "c-rev-2", "GOOD", at(5)); // pending, immediateRemediationPassed
    expect(current().save(s)).toBe(true);
    expect(reload()).toEqual(s);
  });
});

describe("Part 2: Card FSRS survives an old-main write (sidecar)", () => {
  function studiedCard() {
    let s = createLearnerState();
    s = study(s, "c-hypoxia-1", "AGAIN", T0);
    s = study(s, "c-hypoxia-1", "GOOD", at(1));
    s = study(s, "c-hypoxia-1", "GOOD", at(15));
    s = study(s, "c-hypoxia-1", "GOOD", at(3 * DAY));
    return s;
  }

  it("exact CardProgress survives main answering an unrelated Tutor question, and the next rating continues from it", () => {
    const s = studiedCard();
    const card = s.cards!["c-hypoxia-1"]!;
    expect(card.reviews).toBe(4);
    expect(card.schedule.state).toBe(2); // Review
    expect(current().save(s)).toBe(true);

    oldTabDoes((o) => oldAnswersUnrelated(old.markChunkTaught(o, CHUNK1)));
    expect(JSON.parse(store.get(STORAGE_KEY)!).cards).toBeUndefined();

    const back = reload();
    expect(back.cards?.["c-hypoxia-1"]).toEqual(card); // reviews, due, FSRS fields, lastRating, lastReviewedAt
    // main's own change is there too.
    expect(back.progress[REV]!.totalAttempts).toBe(1);

    const later = at(30 * DAY);
    const continued = study(back, "c-hypoxia-1", "GOOD", later).cards!["c-hypoxia-1"]!;
    const expected = study(s, "c-hypoxia-1", "GOOD", later).cards!["c-hypoxia-1"]!;
    expect(continued).toEqual(expected);
    expect(continued.reviews).toBe(5);
    const queue = buildStudyQueue(C, back, L1, later);
    expect(queue.queue.find((c) => c.item.id === "c-hypoxia-1")?.queue).toBe("REVIEW");
  });

  it("migration: PR #6 state with envelope `cards` and no sidecar → cards kept, next save moves them to the sidecar", () => {
    const s = studiedCard();
    store.set(STORAGE_KEY, JSON.stringify(s)); // how earlier PR #6 builds stored cards
    const back = reload();
    expect(back.cards).toEqual(s.cards);
    expect(current().save(back)).toBe(true);
    expect(JSON.parse(store.get(STUDY_CARDS_STORAGE_KEY)!).cards).toEqual(s.cards);
    expect(JSON.parse(store.get(STORAGE_KEY)!).cards).toBeUndefined();
    expect(reload().cards).toEqual(s.cards);
  });

  it("a valid sidecar is authoritative over envelope `cards`", () => {
    const fresh = studiedCard();
    const stale = { ...fresh, cards: { "c-hypoxia-1": { ...fresh.cards!["c-hypoxia-1"]!, reviews: 1 } } };
    current().save(fresh);
    store.set(STORAGE_KEY, JSON.stringify(stale)); // e.g. an older PR #6 tab wrote cards in the envelope
    expect(reload().cards).toEqual(fresh.cards);
  });

  it("malformed sidecar: unreadable → envelope cards (or none); bad records dropped one by one", () => {
    const s = studiedCard();
    for (const bad of ["{not json", "[]", "null", JSON.stringify({ version: 2, cards: {} }), JSON.stringify({ version: 1, cards: [] })]) {
      store.clear();
      store.set(STORAGE_KEY, JSON.stringify(s));
      store.set(STUDY_CARDS_STORAGE_KEY, bad);
      expect(reload().cards, bad).toEqual(s.cards);
      store.delete(STORAGE_KEY);
      store.set(STORAGE_KEY, JSON.stringify({ ...s, cards: undefined }));
      expect(reload().cards ?? {}, bad).toEqual({});
    }
    const good = s.cards!["c-hypoxia-1"]!;
    const result = sanitizeStudyCards({
      version: 1,
      cards: {
        "c-hypoxia-1": good,
        "c-rev-1": { ...good, itemId: "c-rev-1", conceptId: REV, reviews: -1 },
        "c-rev-2": { ...good, itemId: "not-c-rev-2", conceptId: REV },
      },
    })!;
    expect(result.cards).toEqual({ "c-hypoxia-1": good });
    expect(result.dropped.sort()).toEqual(["card:c-rev-1", "card:c-rev-2"]);
  });

  it("quarantine removes untrusted cards from the sidecar and they never come back", () => {
    const overrides = migrateOverrides(legacyV2Payload({ "legacy-c0": "ACTIVE" }))!;
    const s = studiedCard();
    const legacyCard: CardProgress = { ...s.cards!["c-hypoxia-1"]!, itemId: "legacy-c0-r1", conceptId: "legacy-c0" };
    current().save({ ...s, cards: { ...s.cards, "legacy-c0-r1": legacyCard } });

    const result = acceptIncomingLearnerState(reload(), overrides);
    expect(result.changed).toBe(true);
    expect(result.learner.cards?.["legacy-c0-r1"]).toBeUndefined();
    current().save(result.learner);

    expect(JSON.parse(store.get(STUDY_CARDS_STORAGE_KEY)!).cards["legacy-c0-r1"]).toBeUndefined();
    expect(reload().cards?.["legacy-c0-r1"]).toBeUndefined();
    expect(reload().cards?.["c-hypoxia-1"]).toEqual(s.cards!["c-hypoxia-1"]);
  });

  it("clear() removes both the learner envelope and the Study sidecar", () => {
    current().save(studiedCard());
    expect(store.has(STUDY_CARDS_STORAGE_KEY)).toBe(true);
    current().clear();
    expect(store.has(STORAGE_KEY)).toBe(false);
    expect(store.has(STUDY_CARDS_STORAGE_KEY)).toBe(false);
    expect(current().load()).toBeNull();
  });

  it("a Reset in a stale main tab (envelope removed) leaves no ghost card schedules", () => {
    current().save(studiedCard());
    old.clear();
    expect(store.has(STORAGE_KEY)).toBe(false);
    expect(current().load()).toBeNull(); // no learner: the sidecar is not used alone
    // This build starts fresh and saves a Tutor-only change (no cards in memory).
    expect(current().save(markChunkTaught(C, createLearnerState(), CHUNK1))).toBe(true);
    expect(reload().cards ?? {}).toEqual({});
    expect(store.has(STUDY_CARDS_STORAGE_KEY)).toBe(false);
  });

  it("state with no cards in memory never erases a stored sidecar", () => {
    const s = studiedCard();
    current().save(s);
    const { cards: _omit, ...withoutCards } = s;
    void _omit;
    current().save(withoutCards as LearnerState);
    expect(reload().cards).toEqual(s.cards);
  });

  describe("partial writes (localStorage cannot update two keys atomically)", () => {
    it("sidecar write fails → save reports failure and the envelope is NOT written, so both keys keep the last saved pair", () => {
      const first = studiedCard();
      current().save(first);
      const before = { env: store.get(STORAGE_KEY), side: store.get(STUDY_CARDS_STORAGE_KEY) };
      const next = study(first, "c-hypoxia-1", "AGAIN", at(10 * DAY));
      failWrites.add(STUDY_CARDS_STORAGE_KEY);
      expect(current().save(next)).toBe(false);
      expect(store.get(STORAGE_KEY)).toBe(before.env);
      expect(store.get(STUDY_CARDS_STORAGE_KEY)).toBe(before.side);
      expect(reload()).toEqual(first);
    });

    it("envelope write fails after the sidecar → save reports failure; the card is kept (never lost), concept progress is the last saved", () => {
      const first = studiedCard();
      current().save(first);
      const next = study(first, "c-hypoxia-1", "AGAIN", at(10 * DAY));
      failWrites.add(STORAGE_KEY);
      expect(current().save(next)).toBe(false);
      const back = reload();
      expect(back.cards).toEqual(next.cards);
      expect(back.progress).toEqual(first.progress);
    });
  });
});

