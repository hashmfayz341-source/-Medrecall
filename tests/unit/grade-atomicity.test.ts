import { describe, expect, it, vi } from "vitest";
import { pathologyCurriculum } from "@/lib/content/pathology";
import {
  createLearnerState,
  getConcept,
  getItem,
  recordAttempt,
  recordGradedAttempt,
  type GradedAttemptInput,
} from "@/lib/engine/tutor";
import { gradeAnswer, isValidGradeResult, type GradeResult } from "@/lib/grading";
import { requestGrade, gradeFailure, type GradeTransport } from "@/lib/grading/client";
import { toGradeRequest } from "@/lib/grading/request";
import { createSubmitGuard, submitAnswer } from "@/lib/session/submitAnswer";
import { ConceptNotActiveError, InvalidGradeError, ItemConceptMismatchError } from "@/lib/domain/errors";
import type { Curriculum, LearnerState } from "@/lib/domain/types";
import { CORRECT_ATP, WRONG, T0, answer } from "./helpers";

/**
 * Atomicity of the grading boundary.
 *
 * Grading is now asynchronous and can fail. The rule: a learner state
 * transition happens once, and only after a validated grade exists. Any
 * failure — network, server, malformed reply, a concept un-approved mid-flight
 * — leaves learner state exactly as it was. A failed grading request is not a
 * failed retrieval attempt.
 */

const { POST } = await import("@/app/api/grade/route");

const ATP = getConcept(pathologyCurriculum, "c-atp-depletion");
const ATP1 = getItem(ATP, "c-atp-1");
const ATTEMPT: GradedAttemptInput = {
  conceptId: ATP.id,
  itemId: ATP1.id,
  context: "INITIAL",
  chunkId: "chunk-l1-2",
  now: T0,
};

/** A learner with some history, so "unchanged" is a meaningful assertion. */
function seasoned(): LearnerState {
  let learner = createLearnerState();
  learner = answer(learner, "c-hypoxia", "c-hypoxia-1", WRONG, "INITIAL", T0);
  learner = answer(learner, "c-atp-depletion", "c-atp-1", WRONG, "INITIAL", T0);
  return learner;
}

const viaRoute: typeof fetch = async (url, init) =>
  POST(new Request(new URL(String(url), "http://localhost"), init as RequestInit));

const routeTransport: GradeTransport = (request) => requestGrade(request, viaRoute);

function jsonFetch(status: number, body: unknown): typeof fetch {
  return async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

async function expectNoMutation(transport: GradeTransport, learner = seasoned()) {
  const before = structuredClone(learner);
  const outcome = await submitAnswer({
    curriculum: pathologyCurriculum,
    learner,
    attempt: ATTEMPT,
    answer: CORRECT_ATP,
    transport,
  });
  expect(outcome.ok).toBe(false);
  expect(learner).toEqual(before);
  return outcome;
}

describe("success: exactly one transition", () => {
  it("applies the server's grade once, identical to the deterministic path", async () => {
    const learner = seasoned();
    const before = structuredClone(learner);
    const outcome = await submitAnswer({
      curriculum: pathologyCurriculum,
      learner,
      attempt: ATTEMPT,
      answer: CORRECT_ATP,
      transport: routeTransport,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const expected = recordAttempt(pathologyCurriculum, learner, { ...ATTEMPT, answer: CORRECT_ATP });
    expect(outcome.result.learner).toEqual(expected.learner);
    expect(outcome.result.progress.totalAttempts).toBe(
      before.progress[ATP.id]!.totalAttempts + 1,
    );
    // The input was not touched; the caller persists the returned state.
    expect(learner).toEqual(before);
  });
});

describe("failure: zero mutation", () => {
  it("network failure", async () => {
    const outcome = await expectNoMutation((r) =>
      requestGrade(r, async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    expect(outcome).toMatchObject({ ok: false, retryable: true });
  });

  it("server error", async () => {
    await expectNoMutation((r) => requestGrade(r, jsonFetch(500, { error: "boom" })));
    await expectNoMutation((r) => requestGrade(r, jsonFetch(502, { code: "GRADING_UNAVAILABLE" })));
    await expectNoMutation((r) => requestGrade(r, jsonFetch(504, "<html>Gateway Timeout</html>")));
  });

  it("the server's own provider failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = vi.fn(async () => gradeFailure("GRADING_UNAVAILABLE"));
    await expectNoMutation(failing);
    expect(failing).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it("a malformed reply", async () => {
    const good = {
      provider: "deterministic",
      conceptId: ATP.id,
      itemId: ATP1.id,
      grade: gradeAnswer(ATP1, CORRECT_ATP),
      remediation: null,
    };
    const malformed: unknown[] = [
      "not json at all",
      {},
      { ...good, grade: undefined },
      { ...good, grade: { ...good.grade, correct: "yes" } },
      // PARTIAL claiming to be correct: must never be credited.
      { ...good, grade: { ...good.grade, outcome: "PARTIAL", correct: true } },
      { ...good, grade: { ...good.grade, outcome: "CORRECT", correct: false } },
      // A reply for a different concept or item than the one submitted.
      { ...good, conceptId: "c-hypoxia" },
      { ...good, itemId: "c-atp-2" },
      // Remediation must accompany exactly the non-correct grades.
      { ...good, remediation: "unexpected" },
      { ...good, grade: gradeAnswer(ATP1, WRONG), remediation: null },
      { ...good, provider: "" },
    ];
    for (const body of malformed) {
      await expectNoMutation((r) => requestGrade(r, jsonFetch(200, body)));
    }
  });

  it("the concept is un-approved while the answer is being graded", async () => {
    const learner = seasoned();
    const before = structuredClone(learner);
    const unapproved: Curriculum = {
      ...pathologyCurriculum,
      concepts: pathologyCurriculum.concepts.map((c) =>
        c.id === ATP.id ? { ...c, status: "DRAFT" } : c,
      ),
    };
    const outcome = await submitAnswer({
      curriculum: pathologyCurriculum,
      learner,
      attempt: ATTEMPT,
      answer: CORRECT_ATP,
      transport: routeTransport,
      latest: () => ({ curriculum: unapproved, learner }),
    });
    expect(outcome.ok).toBe(false);
    expect(learner).toEqual(before);
  });
});

describe("the gate runs before anything leaves the browser", () => {
  it("DRAFT and DISCARDED concepts are never sent for grading", async () => {
    const draft = getConcept(pathologyCurriculum, "c-draft-lysosomal");
    const discarded: Curriculum = {
      ...pathologyCurriculum,
      concepts: pathologyCurriculum.concepts.map((c) =>
        c.id === ATP.id ? { ...c, status: "DISCARDED" } : c,
      ),
    };
    for (const [curriculum, conceptId, itemId] of [
      [pathologyCurriculum, draft.id, draft.retrievalItems[0]!.id],
      [discarded, ATP.id, ATP1.id],
    ] as const) {
      const transport = vi.fn(routeTransport);
      const learner = seasoned();
      const before = structuredClone(learner);
      const outcome = await submitAnswer({
        curriculum,
        learner,
        attempt: { ...ATTEMPT, conceptId, itemId },
        answer: CORRECT_ATP,
        transport,
      });
      expect(outcome.ok).toBe(false);
      expect(transport).not.toHaveBeenCalled();
      expect(learner).toEqual(before);
    }
  });
});

describe("duplicate submits", () => {
  it("a double tap records exactly one attempt", async () => {
    const guard = createSubmitGuard();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const transport = vi.fn<GradeTransport>(async (request) => {
      await gate;
      return routeTransport(request);
    });

    let learner = seasoned();
    const attemptsBefore = learner.progress[ATP.id]!.totalAttempts;
    const submit = () =>
      guard.run(async () => {
        const outcome = await submitAnswer({
          curriculum: pathologyCurriculum,
          learner,
          attempt: ATTEMPT,
          answer: CORRECT_ATP,
          transport,
        });
        if (outcome.ok) learner = outcome.result.learner;
        return outcome;
      });

    const first = submit();
    const second = submit();
    const third = submit();
    expect(guard.busy).toBe(true);
    release();

    expect(await second).toBeNull();
    expect(await third).toBeNull();
    expect((await first)?.ok).toBe(true);
    expect(transport).toHaveBeenCalledOnce();
    expect(learner.progress[ATP.id]!.totalAttempts).toBe(attemptsBefore + 1);
    expect(guard.busy).toBe(false);
  });

  it("the guard releases after a failure so the learner can retry", async () => {
    const guard = createSubmitGuard();
    await guard.run(async () => {
      throw new Error("x");
    }).catch(() => {});
    expect(guard.busy).toBe(false);
    expect(await guard.run(async () => "retried")).toBe("retried");
  });
});

describe("recordGradedAttempt is pure and gated", () => {
  const grade = gradeAnswer(ATP1, CORRECT_ATP);

  it("refuses DRAFT and DISCARDED concepts without touching state", () => {
    const learner = seasoned();
    const before = structuredClone(learner);
    const draft = getConcept(pathologyCurriculum, "c-draft-lysosomal");
    expect(() =>
      recordGradedAttempt(pathologyCurriculum, learner, {
        ...ATTEMPT,
        conceptId: draft.id,
        itemId: draft.retrievalItems[0]!.id,
      }, grade),
    ).toThrow(ConceptNotActiveError);

    const discarded: Curriculum = {
      ...pathologyCurriculum,
      concepts: pathologyCurriculum.concepts.map((c) =>
        c.id === ATP.id ? { ...c, status: "DISCARDED" } : c,
      ),
    };
    expect(() => recordGradedAttempt(discarded, learner, ATTEMPT, grade)).toThrow(
      ConceptNotActiveError,
    );
    expect(learner).toEqual(before);
  });

  it("refuses an item that is not a representation of the concept", () => {
    const learner = seasoned();
    expect(() =>
      recordGradedAttempt(pathologyCurriculum, learner, { ...ATTEMPT, itemId: "c-hypoxia-1" }, grade),
    ).toThrow();

    // An item stored under the concept but claiming another concept id.
    const forged: Curriculum = {
      ...pathologyCurriculum,
      concepts: pathologyCurriculum.concepts.map((c) =>
        c.id === ATP.id
          ? { ...c, retrievalItems: c.retrievalItems.map((i) => ({ ...i, conceptId: "c-hypoxia" })) }
          : c,
      ),
    };
    expect(() => recordGradedAttempt(forged, learner, ATTEMPT, grade)).toThrow(
      ItemConceptMismatchError,
    );
  });

  it("refuses a structurally invalid grade before mutating anything", () => {
    const learner = seasoned();
    const before = structuredClone(learner);
    const invalid = [
      { ...grade, outcome: "PARTIAL", correct: true },
      { ...grade, outcome: "CORRECT", correct: false },
      { ...grade, outcome: "MAYBE" },
      { correct: true },
    ] as unknown as GradeResult[];
    for (const g of invalid) {
      expect(() => recordGradedAttempt(pathologyCurriculum, learner, ATTEMPT, g)).toThrow(
        InvalidGradeError,
      );
    }
    expect(learner).toEqual(before);
  });

  it("PARTIAL is not credited yet: it lands exactly like INCORRECT (provisional)", () => {
    // Pinned so the Stage B PARTIAL policy has to change this deliberately.
    const learner = seasoned();
    const partial = recordGradedAttempt(pathologyCurriculum, learner, ATTEMPT, {
      ...grade,
      outcome: "PARTIAL",
      correct: false,
    });
    const incorrect = recordGradedAttempt(pathologyCurriculum, learner, ATTEMPT, {
      ...grade,
      outcome: "INCORRECT",
      correct: false,
    });
    expect(partial.progress).toEqual(incorrect.progress);
    expect(partial.learner).toEqual(incorrect.learner);
    expect(partial.progress.mastery).toBe("WEAK");
  });

  it("does not re-grade: the engine acts on the verdict it is given", () => {
    // A wrong answer, but the grader said CORRECT: the engine must not second-guess it.
    const learner = createLearnerState();
    const result = recordGradedAttempt(pathologyCurriculum, learner, ATTEMPT, gradeAnswer(ATP1, CORRECT_ATP));
    expect(result.progress.mastery).toBe("LEARNING");
  });

  it("immediate remediation success still does not clear WEAK", () => {
    let learner = createLearnerState();
    learner = recordGradedAttempt(pathologyCurriculum, learner, ATTEMPT, gradeAnswer(ATP1, WRONG)).learner;
    const after = recordGradedAttempt(
      pathologyCurriculum,
      learner,
      { ...ATTEMPT, itemId: "c-atp-2", context: "IMMEDIATE_REMEDIATION" },
      { outcome: "CORRECT", correct: true, matched: [], missing: [], normalizedAnswer: "x" },
    );
    expect(after.progress.mastery).toBe("WEAK");
    expect(after.progress.immediateRemediationPassed).toBe(true);
  });
});

describe("grade outcome semantics", () => {
  it("the deterministic grader emits only CORRECT or INCORRECT, consistent with `correct`", () => {
    for (const concept of pathologyCurriculum.concepts) {
      for (const item of concept.retrievalItems) {
        for (const text of [CORRECT_ATP, WRONG, "", item.acceptableAnswers[0] ?? "", item.requiredKeywords.map((g) => g[0]).join(" ")]) {
          const g = gradeAnswer(item, text);
          expect(["CORRECT", "INCORRECT"]).toContain(g.outcome);
          expect(g.correct).toBe(g.outcome === "CORRECT");
          expect(isValidGradeResult(g)).toBe(true);
        }
      }
    }
  });

  it("no mastery percentage appears anywhere in a grade", () => {
    const g = gradeAnswer(ATP1, CORRECT_ATP) as unknown as Record<string, unknown>;
    expect(Object.keys(g).sort()).toEqual(["correct", "matched", "missing", "normalizedAnswer", "outcome"]);
  });

  it("the request builder carries only what grading needs", () => {
    const r = toGradeRequest(ATP, ATP1, CORRECT_ATP);
    expect(Object.keys(r).sort()).toEqual(["answer", "concept", "item"]);
    expect(Object.keys(r.concept).sort()).toEqual(
      ["courseId", "id", "lectureId", "source", "status", "summary", "title"],
    );
  });
});
