import {
  recordGradedAttempt,
  resolveAttemptTarget,
  type AttemptResult,
  type GradedAttemptInput,
} from "@/lib/engine/tutor";
import { toGradeRequest } from "@/lib/grading/request";
import type { GradeTransport } from "@/lib/grading/client";
import type { Curriculum, LearnerState } from "@/lib/domain/types";

/**
 * One learner submission, end to end:
 *
 *   gate check → server grades → reply validated → engine applies the grade
 *
 * The engine step runs ONLY after a successful, validated grade. Until then
 * nothing is computed from the attempt, so every failure path returns the
 * learner state exactly as it was. The caller persists `result.learner` only
 * on success.
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
   * The state to apply the grade to once it arrives. Grading is asynchronous,
   * so another tab may have changed curriculum or progress meanwhile; the
   * engine re-checks the gate against whatever is current at that moment.
   * Defaults to the state the attempt started from.
   */
  latest?: () => { curriculum: Curriculum; learner: LearnerState };
}

export type SubmitAnswerOutcome =
  | {
      ok: true;
      result: AttemptResult;
      remediation: string | null;
      provider: string;
    }
  | { ok: false; message: string; retryable: boolean };

const NOT_GRADABLE =
  "This question can no longer be graded — the concept may have been changed or un-approved. Your progress has not changed.";

export async function submitAnswer(args: SubmitAnswerArgs): Promise<SubmitAnswerOutcome> {
  const { attempt, answer } = args;

  let request;
  try {
    // Gate before anything leaves the browser: DRAFT/DISCARDED never go out.
    const { concept, item } = resolveAttemptTarget(
      args.curriculum,
      attempt.conceptId,
      attempt.itemId,
    );
    request = toGradeRequest(concept, item, answer);
  } catch {
    return { ok: false, message: NOT_GRADABLE, retryable: false };
  }

  const graded = await args.transport(request);
  if (!graded.ok) {
    return { ok: false, message: graded.message, retryable: graded.retryable };
  }

  const state = args.latest?.() ?? { curriculum: args.curriculum, learner: args.learner };
  try {
    const result = recordGradedAttempt(
      state.curriculum,
      state.learner,
      attempt,
      graded.response.grade,
    );
    return {
      ok: true,
      result,
      remediation: graded.response.remediation,
      provider: graded.response.provider,
    };
  } catch {
    return { ok: false, message: NOT_GRADABLE, retryable: false };
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
