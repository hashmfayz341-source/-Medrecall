import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { pathologyCurriculum, DEMO_LECTURE_1 } from "@/lib/content/pathology";
import {
  createLearnerState,
  ensureProgress,
  getConcept,
  getItem,
  getNextStep,
  markChunkTaught,
  reconcile,
  type AttemptInput,
  type AttemptResult,
} from "@/lib/engine/tutor";
import { assertActive } from "@/lib/domain/gate";
import { applyRetrievalToMastery } from "@/lib/domain/mastery";
import { scheduleAfterAttempt } from "@/lib/engine/scheduler";
import { gradeAnswer } from "@/lib/grading";
import { requestGrade } from "@/lib/grading/client";
import { submitAnswer } from "@/lib/session/submitAnswer";
import { composeRemediation } from "@/lib/grading/remediation";
import { extractPdfPages } from "@/lib/ingestion/pdf";
import { buildChunks, generateCandidates, toSourceDocument } from "@/lib/ingestion/extractor";
import {
  addIngestedDocument,
  applyOverrides,
  createOverrides,
  setConceptStatuses,
} from "@/lib/domain/curriculum";
import type {
  ConceptProgress,
  Curriculum,
  LearnerState,
  RetrievalContext,
} from "@/lib/domain/types";
import { ANSWERS, WRONG } from "./helpers";

/**
 * Deterministic parity: the server-boundary flow must behave exactly like
 * production did before it.
 *
 * The oracle below is the pre-boundary `recordAttempt`, copied verbatim from
 * main at 0c3f502 — grading and state mutation fused in one function. The new
 * flow is the real thing end to end: toGradeRequest → JSON → POST /api/grade →
 * provider → JSON → response validation → recordGradedAttempt.
 *
 * Every step of every journey is run through BOTH, from the same state, and
 * the entire resulting learner state must be identical before the journey
 * continues. Any drift in mastery, streaks, counters, WEAK handling,
 * remediation, FSRS, completion or interleaving fails at the step it happens.
 */

const { POST } = await import("@/app/api/grade/route");

/* ------------------------------------------------------------------ */
/* The oracle: production's recordAttempt before this change           */
/* ------------------------------------------------------------------ */

function legacyRecordAttempt(
  curriculum: Curriculum,
  learner: LearnerState,
  input: AttemptInput,
): AttemptResult {
  const concept = getConcept(curriculum, input.conceptId);

  // The approval gate, enforced in the domain layer rather than the UI.
  assertActive(concept, "retrieval");

  const item = getItem(concept, input.itemId);
  const grade = gradeAnswer(item, input.answer);

  const before = ensureProgress(learner, concept.id, input.now);
  const afterMastery = applyRetrievalToMastery(before, {
    correct: grade.correct,
    context: input.context,
    at: input.now.toISOString(),
  });
  const schedule = scheduleAfterAttempt(
    concept,
    before,
    grade.correct,
    input.context,
    input.now,
  );
  const progress: ConceptProgress = { ...afterMastery, schedule };

  const injectedByChunk = { ...learner.injectedByChunk };
  if (input.context === "INTERLEAVED" && input.chunkId) {
    const existing = injectedByChunk[input.chunkId] ?? [];
    if (!existing.includes(concept.id)) {
      injectedByChunk[input.chunkId] = [...existing, concept.id];
    }
  }

  const next = reconcile(curriculum, {
    ...learner,
    progress: { ...learner.progress, [concept.id]: progress },
    injectedByChunk,
  });

  return { learner: next, grade, progress, concept, item };
}

/* ------------------------------------------------------------------ */
/* The new flow, through the real route handler                        */
/* ------------------------------------------------------------------ */

const viaRoute: typeof fetch = async (url, init) =>
  POST(new Request(new URL(String(url), "http://localhost"), init as RequestInit));

let comparedSteps = 0;

/** Run one attempt through both paths from the same state and demand equality. */
async function attemptBoth(
  curriculum: Curriculum,
  learner: LearnerState,
  input: AttemptInput,
): Promise<LearnerState> {
  const frozen = structuredClone(learner);
  const legacy = legacyRecordAttempt(curriculum, learner, input);

  const boundary = await submitAnswer({
    curriculum,
    learner,
    attempt: {
      conceptId: input.conceptId,
      itemId: input.itemId,
      context: input.context,
      chunkId: input.chunkId,
      now: input.now,
    },
    answer: input.answer,
    transport: (request) => requestGrade(request, viaRoute),
  });

  const label = `${input.context} ${input.conceptId}/${input.itemId} "${input.answer.slice(0, 30)}"`;
  expect(boundary.ok, label).toBe(true);
  if (!boundary.ok) throw new Error(label);

  // Neither path mutated its input.
  expect(learner, label).toEqual(frozen);

  // The verdict.
  expect(boundary.result.grade.correct, label).toBe(legacy.grade.correct);
  expect(boundary.result.grade.matched, label).toEqual(legacy.grade.matched);
  expect(boundary.result.grade.missing, label).toEqual(legacy.grade.missing);
  expect(boundary.result.grade.normalizedAnswer, label).toEqual(legacy.grade.normalizedAnswer);

  // The concept's progress: mastery, streak, counters, WEAK flags, FSRS card.
  expect(boundary.result.progress, label).toEqual(legacy.progress);

  // The whole learner: completion, taught chunks, interleaving bookkeeping.
  expect(boundary.result.learner, label).toEqual(legacy.learner);

  // Remediation text: what the browser used to compute locally, now from the
  // server, shown in exactly the same cases.
  if (!legacy.grade.correct) {
    // Pre-boundary production computed this in the browser; it is now the
    // deterministic composer, run on the server.
    const local = composeRemediation({
      concept: legacy.concept,
      item: legacy.item,
      grade: legacy.grade,
    });
    expect(boundary.remediation, label).toBe(local);
  } else {
    expect(boundary.remediation, label).toBeNull();
  }

  comparedSteps++;
  return boundary.result.learner;
}

type Answerer = (
  step: Extract<ReturnType<typeof getNextStep>, { item: unknown }>,
  seen: Map<string, number>,
) => string;

/** Drive a lecture exactly as the UI does, comparing at every attempt. */
async function driveBoth(
  curriculum: Curriculum,
  learner: LearnerState,
  lectureId: string,
  now: Date,
  answerer: Answerer,
  maxSteps = 80,
): Promise<{ learner: LearnerState; kinds: string[] }> {
  const kinds: string[] = [];
  const seen = new Map<string, number>();
  let state = learner;
  for (let i = 0; i < maxSteps; i++) {
    const step = getNextStep(curriculum, state, lectureId, now);
    kinds.push(step.kind);
    if (step.kind === "LECTURE_COMPLETE" || step.kind === "AWAITING_APPROVAL") {
      return { learner: state, kinds };
    }
    if (step.kind === "TEACH") {
      state = markChunkTaught(curriculum, state, step.chunk.id);
      continue;
    }
    const answer = answerer(step, seen);
    seen.set(step.concept.id, (seen.get(step.concept.id) ?? 0) + 1);
    state = await attemptBoth(curriculum, state, {
      conceptId: step.concept.id,
      itemId: step.item.id,
      answer,
      context: step.context,
      chunkId: step.chunk.id,
      now,
    });
  }
  throw new Error(`exceeded ${maxSteps} steps: ${kinds.join(",")}`);
}

const L1 = "lecture-cell-injury";
const L2 = "lecture-inflammation";
const T0 = new Date("2026-01-01T09:00:00.000Z");
const day = (n: number) => new Date(T0.getTime() + n * 86_400_000);

const right: Answerer = (step) => ANSWERS[step.concept.id] ?? WRONG;

/** Wrong the first time a concept is asked unaided, right afterwards. */
function failFirst(...conceptIds: string[]): Answerer {
  return (step, seen) =>
    conceptIds.includes(step.concept.id) && !seen.has(step.concept.id)
      ? WRONG
      : (ANSWERS[step.concept.id] ?? WRONG);
}

/** Wrong for the first N asks of a concept, including remediation. */
function failTimes(conceptId: string, times: number): Answerer {
  return (step, seen) =>
    step.concept.id === conceptId && (seen.get(conceptId) ?? 0) < times
      ? WRONG
      : (ANSWERS[step.concept.id] ?? WRONG);
}

describe("deterministic parity through the server boundary", () => {
  it("clean run: both lectures, all correct", async () => {
    const l1 = await driveBoth(pathologyCurriculum, createLearnerState(), L1, T0, right);
    expect(l1.kinds.at(-1)).toBe("LECTURE_COMPLETE");
    const l2 = await driveBoth(pathologyCurriculum, l1.learner, L2, day(3), right);
    expect(l2.kinds.at(-1)).toBe("LECTURE_COMPLETE");
  });

  it("the demo journey: fail, remediate, stay WEAK, interleave, recover", async () => {
    const l1 = await driveBoth(
      pathologyCurriculum,
      createLearnerState(),
      L1,
      T0,
      failFirst("c-atp-depletion"),
    );
    expect(l1.kinds).toContain("REMEDIATE");
    expect(l1.learner.progress["c-atp-depletion"]!.mastery).toBe("WEAK");
    expect(l1.learner.progress["c-atp-depletion"]!.immediateRemediationPassed).toBe(true);

    const l2 = await driveBoth(pathologyCurriculum, l1.learner, L2, day(2), right);
    expect(l2.kinds).toContain("INTERLEAVE");
    expect(l2.learner.progress["c-atp-depletion"]!.mastery).not.toBe("WEAK");
  });

  it("failing remediation repeatedly", async () => {
    const l1 = await driveBoth(
      pathologyCurriculum,
      createLearnerState(),
      L1,
      T0,
      failTimes("c-hypoxia", 3),
    );
    expect(l1.learner.progress["c-hypoxia"]!.totalAttempts).toBeGreaterThanOrEqual(4);
  });

  it("several concepts failed, then an interleaved lapse", async () => {
    const l1 = await driveBoth(
      pathologyCurriculum,
      createLearnerState(),
      L1,
      T0,
      failFirst("c-hypoxia", "c-atp-depletion", "c-cellular-swelling"),
    );
    // Fail the interleaved check too: WEAK must be re-applied identically.
    const lapse: Answerer = (step, seen) =>
      step.kind === "INTERLEAVE" && !seen.has(step.concept.id)
        ? WRONG
        : (ANSWERS[step.concept.id] ?? WRONG);
    await driveBoth(pathologyCurriculum, l1.learner, L2, day(5), lapse);
  });

  it("single attempts in every context, for every item, right and wrong", async () => {
    const contexts: RetrievalContext[] = ["INITIAL", "IMMEDIATE_REMEDIATION", "SPACED", "INTERLEAVED"];
    const warm = (
      await driveBoth(pathologyCurriculum, createLearnerState(), L1, T0, failFirst("c-atp-depletion"))
    ).learner;
    const actives = pathologyCurriculum.concepts.filter((c) => c.status === "ACTIVE");
    for (const start of [createLearnerState(), warm]) {
      for (const concept of actives) {
        for (const item of concept.retrievalItems) {
          const answers = [
            ANSWERS[concept.id] ?? WRONG,
            WRONG,
            item.acceptableAnswers[0] ?? WRONG,
            item.requiredKeywords.map((g) => g[0] ?? "").join(" "),
            "?!",
          ];
          for (const context of contexts) {
            for (const answer of answers) {
              await attemptBoth(pathologyCurriculum, start, {
                conceptId: concept.id,
                itemId: item.id,
                answer,
                context,
                chunkId: "chunk-parity",
                now: day(4),
              });
            }
          }
        }
      }
    }
  });

  it("spaced reviews over weeks keep the same FSRS schedule", async () => {
    let learner = (
      await driveBoth(pathologyCurriculum, createLearnerState(), L1, T0, failFirst("c-atp-depletion"))
    ).learner;
    const pattern = [true, true, false, true, true, true];
    let when = 1;
    for (const ok of pattern) {
      when += 3;
      learner = await attemptBoth(pathologyCurriculum, learner, {
        conceptId: "c-atp-depletion",
        itemId: "c-atp-2",
        answer: ok ? ANSWERS["c-atp-depletion"]! : WRONG,
        context: "SPACED",
        now: day(when),
      });
    }
    expect(learner.progress["c-atp-depletion"]!.totalAttempts).toBeGreaterThan(pattern.length);
  });

  describe("ingested PDF material", () => {
    let curriculum: Curriculum;

    beforeAll(async () => {
      const bytes = new Uint8Array(readFileSync("tests/fixtures/cell-injury.pdf"));
      const doc = await extractPdfPages(bytes, "cell-injury.pdf", {
        courseId: "course-pathology",
        lectureId: DEMO_LECTURE_1,
      });
      const candidates = generateCandidates(doc, {
        courseId: "course-pathology",
        lectureId: DEMO_LECTURE_1,
      });
      const ov = addIngestedDocument(
        createOverrides(),
        {
          lectureId: DEMO_LECTURE_1,
          document: toSourceDocument(doc, DEMO_LECTURE_1),
          chunks: buildChunks(doc, DEMO_LECTURE_1, candidates, 2),
          ingestedAt: T0.toISOString(),
        },
        candidates,
      );
      curriculum = applyOverrides(
        pathologyCurriculum,
        setConceptStatuses(ov, candidates.map((c) => c.id), "ACTIVE"),
      );
    });

    it("approved PDF concepts grade and schedule identically", async () => {
      const keywords: Answerer = (step, seen) =>
        (seen.get(step.concept.id) ?? 0) === 0 && step.concept.id.includes("-p2-")
          ? WRONG
          : (ANSWERS[step.concept.id] ??
            step.item.requiredKeywords.map((g) => g[0] ?? "").join(" "));
      const run = await driveBoth(curriculum, createLearnerState(), L1, T0, keywords, 200);
      expect(run.kinds.at(-1)).toBe("LECTURE_COMPLETE");
    });
  });

  it("actually compared a meaningful number of attempts", () => {
    expect(comparedSteps).toBeGreaterThan(500);
  });
});

// Keeps route logging quiet if a comparison ever fails mid-request.
vi.spyOn(console, "error").mockImplementation(() => {});
