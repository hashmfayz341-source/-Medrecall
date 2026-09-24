import { describe, expect, it, vi, beforeEach } from "vitest";
import { pathologyCurriculum } from "@/lib/content/pathology";
import {
  captureAttemptPrecondition,
  createLearnerState,
  getConcept,
  getItem,
  gradingTargetFingerprint,
  recordAttempt,
  recordGradedAttempt,
  type GradedAttemptInput,
} from "@/lib/engine/tutor";
import { gradeAnswer } from "@/lib/grading";
import { ConceptNotActiveError, StaleAttemptError } from "@/lib/domain/errors";
import { requestGrade, type GradeTransport } from "@/lib/grading/client";
import { submitAnswer } from "@/lib/session/submitAnswer";
import type { Concept, Curriculum, LearnerState, RetrievalItem } from "@/lib/domain/types";
import { ANSWERS, CORRECT_ATP, WRONG } from "./helpers";

/**
 * H1 — stale asynchronous grades.
 *
 * Grading is asynchronous. While a request is pending, another tab (or a
 * later request) can answer the same concept, edit it, change its source or
 * rubric, or un-approve it. A grade computed against the OLD question and the
 * OLD progress must never be folded into the NEW state: that would record one
 * logical question twice, advance mastery and FSRS twice, run FSRS with an
 * attempt time older than the card's last review, or credit an answer graded
 * against a rubric that no longer exists.
 *
 * Unrelated progress changes (a different concept) must NOT invalidate the
 * attempt, and must survive it.
 */

// Records every FSRS call so a stale application can be caught in the act.
const fsrs = vi.hoisted(() => ({ calls: [] as { now: Date; lastReview?: string }[] }));
vi.mock("@/lib/engine/scheduler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/engine/scheduler")>();
  return {
    ...actual,
    scheduleAfterAttempt: (...args: Parameters<typeof actual.scheduleAfterAttempt>) => {
      const [, progress, , , now] = args;
      fsrs.calls.push({ now, lastReview: progress.schedule.last_review });
      return actual.scheduleAfterAttempt(...args);
    },
  };
});

const { POST } = await import("@/app/api/grade/route");

const ATP = getConcept(pathologyCurriculum, "c-atp-depletion");
const ATP1 = getItem(ATP, "c-atp-1");
const HYPOXIA = getConcept(pathologyCurriculum, "c-hypoxia");

const T0 = new Date("2026-02-01T09:00:00.000Z");
const T1 = new Date("2026-02-01T09:05:00.000Z"); // submission
const T2 = new Date("2026-02-01T09:06:00.000Z"); // the other tab's attempt

const viaRoute: typeof fetch = async (url, init) =>
  POST(new Request(new URL(String(url), "http://localhost"), init as RequestInit));

/** A transport whose reply is held until the test releases it. */
function heldTransport() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const transport: GradeTransport = async (request) => {
    await gate;
    return requestGrade(request, viaRoute);
  };
  return { transport, release };
}

const ATTEMPT: GradedAttemptInput = {
  conceptId: ATP.id,
  itemId: ATP1.id,
  context: "INITIAL",
  chunkId: "chunk-l1-2",
  now: T1,
};

function withConcept(curriculum: Curriculum, id: string, change: (c: Concept) => Concept): Curriculum {
  return {
    ...curriculum,
    concepts: curriculum.concepts.map((c) => (c.id === id ? change(c) : c)),
  };
}

function withItem(change: (i: RetrievalItem) => RetrievalItem): Curriculum {
  return withConcept(pathologyCurriculum, ATP.id, (c) => ({
    ...c,
    retrievalItems: c.retrievalItems.map((i) => (i.id === ATP1.id ? change(i) : i)),
  }));
}

/**
 * Start an attempt from `start`, let the world move to `later` while the
 * grade is pending, then release the grade.
 */
async function raceAgainst(
  later: { curriculum: Curriculum; learner: LearnerState },
  start: { curriculum: Curriculum; learner: LearnerState } = {
    curriculum: pathologyCurriculum,
    learner: createLearnerState(),
  },
  answer = CORRECT_ATP,
) {
  const { transport, release } = heldTransport();
  let current = start;
  const pending = submitAnswer({
    curriculum: start.curriculum,
    learner: start.learner,
    attempt: ATTEMPT,
    answer,
    transport,
    latest: () => current,
  });
  current = later;
  const snapshot = structuredClone(later.learner);
  fsrs.calls.length = 0;
  release();
  const outcome = await pending;
  return { outcome, snapshot, fsrsCallsDuringApply: [...fsrs.calls] };
}

function expectStale(result: Awaited<ReturnType<typeof raceAgainst>>, later: LearnerState) {
  expect(result.outcome.ok).toBe(false);
  if (result.outcome.ok) return;
  expect(result.outcome.reason).toBe("STALE");
  expect(result.outcome.retryable).toBe(false);
  // Nothing was applied: no mastery, no FSRS, no interleaving bookkeeping.
  expect(later).toEqual(result.snapshot);
  expect(result.fsrsCallsDuringApply).toEqual([]);
}

beforeEach(() => {
  fsrs.calls.length = 0;
});

describe("H1: a pending grade is not applied to state that moved on", () => {
  it("1. the same concept was answered in another tab while grading was pending", async () => {
    const otherTab = recordAttempt(pathologyCurriculum, createLearnerState(), {
      ...ATTEMPT,
      answer: WRONG,
      now: T2,
    }).learner;
    expect(otherTab.progress[ATP.id]!.totalAttempts).toBe(1);

    const result = await raceAgainst({ curriculum: pathologyCurriculum, learner: otherTab });
    expectStale(result, otherTab);
    // Specifically: FSRS was never run with an attempt time (T1) older than
    // the card's current last review (T2).
    expect(otherTab.progress[ATP.id]!.schedule.last_review).toBe(T2.toISOString());
    expect(result.outcome.ok).toBe(false);
  });

  it("1b. the stale grade cannot double-count even when both answers were right", async () => {
    const otherTab = recordAttempt(pathologyCurriculum, createLearnerState(), {
      ...ATTEMPT,
      answer: CORRECT_ATP,
      now: T2,
    }).learner;
    const result = await raceAgainst({ curriculum: pathologyCurriculum, learner: otherTab });
    expectStale(result, otherTab);
    expect(otherTab.progress[ATP.id]!.totalAttempts).toBe(1);
  });

  it("2a. the concept's wording was edited while grading was pending", async () => {
    const edited = withConcept(pathologyCurriculum, ATP.id, (c) => ({
      ...c,
      title: "ATP depletion (reviewed)",
      summary: `${c.summary} Reviewed wording.`,
    }));
    const result = await raceAgainst({ curriculum: edited, learner: createLearnerState() });
    expectStale(result, createLearnerState());
  });

  it("2b. the retrieval item was edited while grading was pending", async () => {
    const edited = withItem((i) => ({ ...i, prompt: `${i.prompt} (revised)` }));
    const result = await raceAgainst({ curriculum: edited, learner: createLearnerState() });
    expectStale(result, createLearnerState());
  });

  it("3a. the source excerpt changed while grading was pending", async () => {
    const edited = withConcept(pathologyCurriculum, ATP.id, (c) => ({
      ...c,
      source: { ...c.source, excerpt: `${c.source.excerpt} (corrected)` },
    }));
    const result = await raceAgainst({ curriculum: edited, learner: createLearnerState() });
    expectStale(result, createLearnerState());
  });

  it("3b. the rubric changed while grading was pending", async () => {
    const edited = withItem((i) => ({
      ...i,
      requiredKeywords: [...i.requiredKeywords, ["mitochondria"]],
    }));
    const result = await raceAgainst({ curriculum: edited, learner: createLearnerState() });
    expectStale(result, createLearnerState());

    const answers = withItem((i) => ({ ...i, acceptableAnswers: [...i.acceptableAnswers, "anything"] }));
    const again = await raceAgainst({ curriculum: answers, learner: createLearnerState() });
    expectStale(again, createLearnerState());
  });

  it("4. approval was removed while grading was pending", async () => {
    const unapproved = withConcept(pathologyCurriculum, ATP.id, (c) => ({ ...c, status: "DRAFT" }));
    const result = await raceAgainst({ curriculum: unapproved, learner: createLearnerState() });
    expect(result.outcome.ok).toBe(false);
    if (!result.outcome.ok) expect(result.outcome.reason).toBe("NOT_GRADABLE");
    expect(result.fsrsCallsDuringApply).toEqual([]);
  });

  it("5. unrelated progress changing does not invalidate the attempt, and survives it", async () => {
    const otherTab = recordAttempt(pathologyCurriculum, createLearnerState(), {
      conceptId: HYPOXIA.id,
      itemId: HYPOXIA.retrievalItems[0]!.id,
      answer: ANSWERS[HYPOXIA.id]!,
      context: "INITIAL",
      now: T2,
    }).learner;

    const result = await raceAgainst({ curriculum: pathologyCurriculum, learner: otherTab });
    expect(result.outcome.ok).toBe(true);
    if (!result.outcome.ok) return;
    const learner = result.outcome.result.learner;
    // The other tab's work is kept, not overwritten.
    expect(learner.progress[HYPOXIA.id]).toEqual(otherTab.progress[HYPOXIA.id]);
    expect(learner.progress[ATP.id]!.totalAttempts).toBe(1);
    // And it is exactly what applying this attempt to the newer state gives.
    expect(learner).toEqual(
      recordAttempt(pathologyCurriculum, otherTab, { ...ATTEMPT, answer: CORRECT_ATP }).learner,
    );
  });

  it("an unchanged world still applies normally", async () => {
    const start = { curriculum: pathologyCurriculum, learner: createLearnerState() };
    const result = await raceAgainst(start, start);
    expect(result.outcome.ok).toBe(true);
    expect(result.fsrsCallsDuringApply).toHaveLength(1);
  });

  it("never runs FSRS with an attempt time older than the card's last review", async () => {
    // The card was last reviewed at T2, and nothing changes while grading is
    // pending — but this attempt claims T1. Folding it in would move FSRS
    // backwards in time.
    const reviewed = recordAttempt(pathologyCurriculum, createLearnerState(), {
      ...ATTEMPT,
      answer: WRONG,
      now: T2,
    }).learner;
    const state = { curriculum: pathologyCurriculum, learner: reviewed };
    const result = await raceAgainst(state, state);
    expect(result.outcome.ok).toBe(false);
    for (const call of result.fsrsCallsDuringApply) {
      if (call.lastReview) {
        expect(call.now.getTime()).toBeGreaterThanOrEqual(new Date(call.lastReview).getTime());
      }
    }
    expect(result.fsrsCallsDuringApply).toEqual([]);
  });

  it("a stale reply for a concept answered earlier still refuses after T0 history", async () => {
    // History exists (attempt at T0); submission at T1 captures it; the other
    // tab adds T2. Precondition must compare against what was captured.
    const history = recordAttempt(pathologyCurriculum, createLearnerState(), {
      ...ATTEMPT,
      answer: WRONG,
      now: T0,
    }).learner;
    const otherTab = recordAttempt(pathologyCurriculum, history, {
      ...ATTEMPT,
      itemId: "c-atp-2",
      context: "IMMEDIATE_REMEDIATION",
      answer: ANSWERS[ATP.id]!,
      now: T2,
    }).learner;
    const result = await raceAgainst(
      { curriculum: pathologyCurriculum, learner: otherTab },
      { curriculum: pathologyCurriculum, learner: history },
    );
    expectStale(result, otherTab);
  });
});

describe("H1 in the engine: recordGradedAttempt's precondition", () => {
  const grade = gradeAnswer(ATP1, CORRECT_ATP);

  function staleReason(fn: () => unknown): string | null {
    try {
      fn();
      return null;
    } catch (cause) {
      if (cause instanceof StaleAttemptError) return cause.reason;
      throw cause;
    }
  }

  it("capturing a precondition is gated: DRAFT and DISCARDED throw", () => {
    const draft = getConcept(pathologyCurriculum, "c-draft-lysosomal");
    expect(() =>
      captureAttemptPrecondition(pathologyCurriculum, createLearnerState(), draft.id, draft.retrievalItems[0]!.id),
    ).toThrow(ConceptNotActiveError);
    const discarded = withConcept(pathologyCurriculum, ATP.id, (c) => ({ ...c, status: "DISCARDED" }));
    expect(() => captureAttemptPrecondition(discarded, createLearnerState(), ATP.id, ATP1.id)).toThrow(
      ConceptNotActiveError,
    );
  });

  it("a holding precondition changes nothing about the result", () => {
    const learner = createLearnerState();
    const pre = captureAttemptPrecondition(pathologyCurriculum, learner, ATP.id, ATP1.id);
    expect(recordGradedAttempt(pathologyCurriculum, learner, ATTEMPT, grade, pre)).toEqual(
      recordGradedAttempt(pathologyCurriculum, learner, ATTEMPT, grade),
    );
  });

  it("names the reason for each kind of staleness", () => {
    const learner = createLearnerState();
    const pre = captureAttemptPrecondition(pathologyCurriculum, learner, ATP.id, ATP1.id);

    expect(
      staleReason(() =>
        recordGradedAttempt(pathologyCurriculum, learner, { ...ATTEMPT, itemId: "c-atp-2" }, grade, pre),
      ),
    ).toBe("TARGET_MISMATCH");

    const edited = withItem((i) => ({ ...i, explanation: `${i.explanation}!` }));
    expect(staleReason(() => recordGradedAttempt(edited, learner, ATTEMPT, grade, pre))).toBe(
      "TARGET_CHANGED",
    );

    const moved = recordAttempt(pathologyCurriculum, learner, { ...ATTEMPT, answer: WRONG, now: T2 }).learner;
    expect(staleReason(() => recordGradedAttempt(pathologyCurriculum, moved, ATTEMPT, grade, pre))).toBe(
      "PROGRESS_CHANGED",
    );

    // Same progress version as captured, but the attempt claims a time before
    // the card's last review: FSRS must not be run backwards.
    const reviewed = recordAttempt(pathologyCurriculum, learner, { ...ATTEMPT, answer: WRONG, now: T2 }).learner;
    const preReviewed = captureAttemptPrecondition(pathologyCurriculum, reviewed, ATP.id, ATP1.id);
    expect(
      staleReason(() =>
        recordGradedAttempt(pathologyCurriculum, reviewed, { ...ATTEMPT, now: T1 }, grade, preReviewed),
      ),
    ).toBe("OUT_OF_ORDER");
    // At or after the last review is fine.
    expect(
      staleReason(() =>
        recordGradedAttempt(pathologyCurriculum, reviewed, { ...ATTEMPT, now: T2 }, grade, preReviewed),
      ),
    ).toBeNull();
  });

  it("the fingerprint covers every concept grading field, the SourceRef and the item content", () => {
    const base = gradingTargetFingerprint(ATP, ATP1);
    const conceptChanges: ((c: Concept) => Concept)[] = [
      (c) => ({ ...c, id: `${c.id}-x` }),
      (c) => ({ ...c, courseId: `${c.courseId}-x` }),
      (c) => ({ ...c, lectureId: `${c.lectureId}-x` }),
      (c) => ({ ...c, title: `${c.title} x` }),
      (c) => ({ ...c, summary: `${c.summary} x` }),
      (c) => ({ ...c, status: "DRAFT" }),
      (c) => ({ ...c, source: { ...c.source, courseId: "x" } }),
      (c) => ({ ...c, source: { ...c.source, lectureId: "x" } }),
      (c) => ({ ...c, source: { ...c.source, documentId: "x" } }),
      (c) => ({ ...c, source: { ...c.source, pageNumber: c.source.pageNumber + 1 } }),
      (c) => ({ ...c, source: { ...c.source, excerpt: `${c.source.excerpt} x` } }),
    ];
    for (const change of conceptChanges) {
      expect(gradingTargetFingerprint(change(ATP), ATP1)).not.toBe(base);
    }
    const itemChanges: ((i: RetrievalItem) => RetrievalItem)[] = [
      (i) => ({ ...i, id: `${i.id}-x` }),
      (i) => ({ ...i, conceptId: "x" }),
      (i) => ({ ...i, kind: "CLOZE" }),
      (i) => ({ ...i, prompt: `${i.prompt} x` }),
      (i) => ({ ...i, requiredKeywords: [...i.requiredKeywords, ["x"]] }),
      (i) => ({ ...i, requiredKeywords: i.requiredKeywords.map((g, n) => (n === 0 ? [...g, "x"] : g)) }),
      (i) => ({ ...i, acceptableAnswers: [...i.acceptableAnswers, "x"] }),
      (i) => ({ ...i, explanation: `${i.explanation} x` }),
    ];
    for (const change of itemChanges) {
      expect(gradingTargetFingerprint(ATP, change(ATP1))).not.toBe(base);
    }
    // Deterministic.
    expect(gradingTargetFingerprint(structuredClone(ATP), structuredClone(ATP1))).toBe(base);
  });

  it("the synchronous deterministic wrapper is unaffected (no precondition)", () => {
    const learner = recordAttempt(pathologyCurriculum, createLearnerState(), { ...ATTEMPT, answer: WRONG, now: T2 }).learner;
    // Out-of-order times through the plain wrapper behave exactly as before.
    expect(() => recordAttempt(pathologyCurriculum, learner, { ...ATTEMPT, answer: CORRECT_ATP, now: T1 })).not.toThrow();
  });
});
