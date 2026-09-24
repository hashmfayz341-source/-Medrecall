import { isValidGradeResult, sanitizeGradeResult } from "@/lib/grading";
import {
  GRADE_REQUEST_LIMITS,
  type GradeRequest,
  type GradeResponse,
} from "@/lib/grading/request";
import type { GradingFailure } from "@/lib/grading/errors";
import type { AiProvider } from "./provider";

export type { GradingFailure };

/**
 * The server side of the grading boundary.
 *
 * Runs a provider against one validated request and turns whatever comes back
 * into either a small, validated GradeResponse or a failure code. Provider
 * output is untrusted: a hosted model can time out, throw, return the wrong
 * shape, or re-teach without citing the source. Each of those is a failure,
 * and a failure never produces a partial response the browser could act on.
 *
 * This module never sees learner state. It decides the assessment only.
 */

export type GradingOutcome =
  | { ok: true; response: GradeResponse }
  | { ok: false; failure: GradingFailure };

/**
 * Per provider call. A wrong answer makes two calls (grade, then remediation),
 * so two full timeouts still finish inside the route's 30 s maxDuration and
 * well inside the browser's 35 s timeout — a slow provider surfaces as a clean
 * retryable 504, never as a platform timeout.
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

/**
 * Remediation is only acceptable if it quotes the concept's verbatim source
 * excerpt. That keeps re-teaching anchored to the approved page rather than
 * to whatever a model chose to say.
 */
export function isSourceGrounded(remediation: string, excerpt: string): boolean {
  const quote = excerpt.trim();
  return quote.length > 0 && remediation.includes(quote);
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
    raw = await withTimeout(provider.gradeFreeAnswer(item, answer), timeoutMs);
  } catch (cause) {
    return { ok: false, failure: cause instanceof Timeout ? "PROVIDER_TIMEOUT" : "PROVIDER_ERROR" };
  }
  if (!isValidGradeResult(raw)) return { ok: false, failure: "MALFORMED_GRADE" };
  const grade = sanitizeGradeResult(raw);

  let remediation: string | null = null;
  if (grade.outcome !== "CORRECT") {
    let text: unknown;
    try {
      text = await withTimeout(
        provider.generateRemediation({ concept, item, grade, learnerAnswer: answer }),
        timeoutMs,
      );
    } catch (cause) {
      return {
        ok: false,
        failure: cause instanceof Timeout ? "PROVIDER_TIMEOUT" : "PROVIDER_ERROR",
      };
    }
    if (
      typeof text !== "string" ||
      text.trim().length === 0 ||
      text.length > GRADE_REQUEST_LIMITS.maxRemediationChars
    ) {
      return { ok: false, failure: "MALFORMED_REMEDIATION" };
    }
    if (!isSourceGrounded(text, concept.source.excerpt)) {
      return { ok: false, failure: "UNGROUNDED_REMEDIATION" };
    }
    remediation = text;
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
