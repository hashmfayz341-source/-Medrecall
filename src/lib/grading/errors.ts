import type { GradeRequestError } from "./request";

/**
 * What the browser is told when grading does not happen.
 *
 * Fixed strings, keyed by a fixed code. No exception text, stack trace,
 * provider response, prompt or file path ever reaches the response, and the
 * browser displays these by code rather than trusting a message it was sent.
 *
 * Every one of these means the same thing for the learner: the attempt was
 * NOT recorded and progress has not changed.
 */
/** Why a provider could not produce a usable assessment (server-side only). */
export type GradingFailure =
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_ERROR"
  | "MALFORMED_GRADE"
  | "REMEDIATION_UNAVAILABLE";

export type GradeErrorCode =
  | GradeRequestError
  | "REQUEST_TOO_LARGE"
  | "GRADING_UNAVAILABLE";

export interface GradeErrorResponse {
  status: number;
  error: string;
  /** Whether trying the same submission again could succeed. */
  retryable: boolean;
}

const UNAVAILABLE =
  "Grading is unavailable right now. Your answer was not recorded and your progress has not changed. Please try again.";

export const GRADE_ERRORS: Record<GradeErrorCode, GradeErrorResponse> = {
  INVALID_REQUEST: {
    status: 400,
    error: "This answer could not be submitted for grading. Your progress has not changed.",
    retryable: false,
  },
  CONCEPT_NOT_ACTIVE: {
    status: 422,
    error: "This concept is not approved for learning, so it cannot be graded.",
    retryable: false,
  },
  ITEM_CONCEPT_MISMATCH: {
    status: 400,
    error: "This question does not belong to that concept, so it cannot be graded.",
    retryable: false,
  },
  MISSING_SOURCE: {
    status: 400,
    error: "This concept has no usable source reference, so it cannot be graded.",
    retryable: false,
  },
  EMPTY_ANSWER: {
    status: 400,
    error: "Write an answer before submitting.",
    retryable: false,
  },
  ANSWER_TOO_LONG: {
    status: 413,
    error: "That answer is too long. Shorten it and submit again.",
    retryable: false,
  },
  REQUEST_TOO_LARGE: {
    status: 413,
    error: "This answer could not be submitted for grading. Your progress has not changed.",
    retryable: false,
  },
  GRADING_UNAVAILABLE: {
    status: 502,
    error: UNAVAILABLE,
    retryable: true,
  },
};

/** Provider-side failures all look the same to the learner: try again. */
export function gradingFailureStatus(failure: GradingFailure): number {
  return failure === "PROVIDER_TIMEOUT" ? 504 : 502;
}

export function isGradeErrorCode(value: unknown): value is GradeErrorCode {
  return typeof value === "string" && Object.hasOwn(GRADE_ERRORS, value);
}
