import { isValidGradeResult, sanitizeGradeResult } from "@/lib/grading";
import {
  GRADE_REQUEST_LIMITS,
  type GradeRequest,
  type GradeResponse,
} from "@/lib/grading/request";
import type { GradingFailure } from "@/lib/grading/errors";
import {
  composeRemediation,
  quotesSourceExcerpt,
  restrictToReviewedTerms,
} from "@/lib/grading/remediation";
import type { AiProvider } from "./provider";

export type { GradingFailure };

/**
 * The server side of the grading boundary.
 *
 * Runs a provider against one validated request and turns whatever comes back
 * into either a small, validated GradeResponse or a failure code. Provider
 * output is untrusted: a hosted model can time out, throw or return the wrong
 * shape. Each of those is a failure, and a failure never produces a partial
 * response the browser could act on.
 *
 * The provider decides the ASSESSMENT only — the outcome, and which of the
 * item's own rubric terms were matched or missed. It writes no learner-facing
 * text: remediation is composed here, deterministically, from the item's
 * reviewed explanation and the concept's verbatim source excerpt
 * (`composeRemediation`). This module never sees learner state.
 */

export type GradingOutcome =
  | { ok: true; response: GradeResponse }
  | { ok: false; failure: GradingFailure };

/**
 * Per provider call. Two full timeouts would still finish inside the route's
 * 30 s maxDuration and well inside the browser's 35 s timeout — a slow
 * provider surfaces as a clean retryable 504, never as a platform timeout.
 */
export const DEFAULT_GRADING_TIMEOUT_MS = 12_000;

class Timeout extends Error {}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Timeout()), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function gradeWithProvider(
  provider: AiProvider,
  request: GradeRequest,
  options: { timeoutMs?: number } = {},
): Promise<GradingOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GRADING_TIMEOUT_MS;
  const { concept, item, answer } = request;

  let raw: unknown;
  try {
    // The grader sees the approved concept and its source, not just the item.
    raw = await withTimeout(provider.gradeFreeAnswer({ concept, item, answer }), timeoutMs);
  } catch (cause) {
    return { ok: false, failure: cause instanceof Timeout ? "PROVIDER_TIMEOUT" : "PROVIDER_ERROR" };
  }
  if (!isValidGradeResult(raw)) return { ok: false, failure: "MALFORMED_GRADE" };
  const checked = sanitizeGradeResult(raw);

  // Terms a grader reports are limited to this item's reviewed vocabulary, so
  // no provider-invented wording travels onward in the grade either.
  const grade = {
    ...checked,
    matched: restrictToReviewedTerms(checked.matched, item),
    missing: restrictToReviewedTerms(checked.missing, item),
  };

  let remediation: string | null = null;
  if (grade.outcome !== "CORRECT") {
    remediation = composeRemediation({ concept, item, grade });
    // Tripwire on our own composer, not a grounding proof: see
    // quotesSourceExcerpt(). Free-form text is never admitted by this check.
    if (
      remediation.length > GRADE_REQUEST_LIMITS.maxRemediationChars ||
      !quotesSourceExcerpt(remediation, concept.source.excerpt)
    ) {
      return { ok: false, failure: "REMEDIATION_UNAVAILABLE" };
    }
  }

  return {
    ok: true,
    response: {
      provider: provider.name,
      conceptId: concept.id,
      itemId: item.id,
      grade,
      remediation,
    },
  };
}
