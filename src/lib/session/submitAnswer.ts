import {
  captureAttemptPrecondition,
  recordGradedAttempt,
  resolveAttemptTarget,
  type AttemptResult,
  type GradedAttemptInput,
} from "@/lib/engine/tutor";
import { StaleAttemptError } from "@/lib/domain/errors";
import { toGradeRequest } from "@/lib/grading/request";
import type { GradeTransport } from "@/lib/grading/client";
import type { Curriculum, LearnerState } from "@/lib/domain/types";

/**
 * One learner submission, end to end:
 *
 *   gate check + precondition captured → server grades → reply validated
 *   → precondition re-checked against CURRENT state → engine applies the grade
 *
 * The engine step runs ONLY after a successful, validated grade, and only if
 * the question and this concept's progress are still exactly what the learner
 * answered (optimistic concurrency). If another tab answered the same concept,
 * or the concept, item, rubric or source was edited, the grade is STALE and is
 * discarded. Every failure path returns the learner state exactly as it was.
 * The caller persists `result.learner` only on success.
 *
 * Framework-free: the UI supplies the transport, which keeps this testable and
 * keeps provider code out of the browser.
 */

export interface SubmitAnswerArgs {
  curriculum: Curriculum;
  learner: LearnerState;
  attempt: GradedAttemptInput;
  answer: string;
  transport: GradeTransport;
  /**
   * The state to apply the grade to once it arrives — the freshest available,
   * ideally read from storage rather than a render snapshot. Grading is
   * asynchronous, so another tab may have changed curriculum or progress
   * meanwhile; the gate and the precondition are re-checked against it.
   * Defaults to the state the attempt started from.
   */
  latest?: () => { curriculum: Curriculum; learner: LearnerState };
}

/**
 * - GRADING_FAILED: the request or reply failed; the same answer may be retried.
 * - STALE: the grade is for a question or progress that has since changed.
 *   Nothing was recorded; the learner should continue to the current question.
 * - NOT_GRADABLE: the concept cannot be graded now (e.g. no longer approved).
 */
export type SubmitFailureReason = "GRADING_FAILED" | "STALE" | "NOT_GRADABLE";

export type SubmitAnswerOutcome =
  | {
      ok: true;
      result: AttemptResult;
      remediation: string | null;
      provider: string;
    }
  | { ok: false; reason: SubmitFailureReason; message: string; retryable: boolean };

const NOT_GRADABLE =
  "This question can no longer be graded — the concept may have been changed or un-approved. Your progress has not changed.";

export const STALE_MESSAGE =
  "This question changed while your answer was being graded — it was answered or edited elsewhere, for example in another tab. Your answer was not recorded and your progress has not changed.";

export async function submitAnswer(args: SubmitAnswerArgs): Promise<SubmitAnswerOutcome> {
  const { attempt, answer } = args;

  let request;
  let precondition;
  try {
    // Gate before anything leaves the browser: DRAFT/DISCARDED never go out.
    const { concept, item } = resolveAttemptTarget(
      args.curriculum,
      attempt.conceptId,
      attempt.itemId,
    );
    // What the learner actually answered: this question, this progress.
    precondition = captureAttemptPrecondition(
      args.curriculum,
      args.learner,
      attempt.conceptId,
      attempt.itemId,
    );
    request = toGradeRequest(concept, item, answer);
  } catch {
    return { ok: false, reason: "NOT_GRADABLE", message: NOT_GRADABLE, retryable: false };
  }

  const graded = await args.transport(request);
  if (!graded.ok) {
    return {
      ok: false,
      reason: "GRADING_FAILED",
      message: graded.message,
      retryable: graded.retryable,
    };
  }

  const state = args.latest?.() ?? { curriculum: args.curriculum, learner: args.learner };
  try {
    const result = recordGradedAttempt(
      state.curriculum,
      state.learner,
      attempt,
      graded.response.grade,
      precondition,
    );
    return {
      ok: true,
      result,
      remediation: graded.response.remediation,
      provider: graded.response.provider,
    };
  } catch (cause) {
    if (cause instanceof StaleAttemptError) {
      return { ok: false, reason: "STALE", message: STALE_MESSAGE, retryable: false };
    }
    return { ok: false, reason: "NOT_GRADABLE", message: NOT_GRADABLE, retryable: false };
  }
}

/**
 * Single-flight guard. While one submission is in flight, further calls are
 * dropped rather than queued, so a double tap can never record two attempts.
 */
export function createSubmitGuard() {
  let inFlight = false;
  return {
    get busy() {
      return inFlight;
    },
    async run<T>(work: () => Promise<T>): Promise<T | null> {
      if (inFlight) return null;
      inFlight = true;
      try {
        return await work();
      } finally {
        inFlight = false;
      }
    },
  };
}
