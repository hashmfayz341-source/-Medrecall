import {
  parseGradeResponse,
  type GradeRequest,
  type GradeResponse,
} from "./request";
import { GRADE_ERRORS, isGradeErrorCode, type GradeErrorCode } from "./errors";

/**
 * Browser side of the grading boundary: send one attempt to POST /api/grade
 * and validate the reply before anything acts on it.
 *
 * No provider code lives here. A failure of any kind — network, timeout,
 * non-2xx, unparseable or mismatched reply — comes back as a value, never as a
 * half-applied result.
 */

export const GRADE_ENDPOINT = "/api/grade";
export const CLIENT_GRADE_TIMEOUT_MS = 35_000;

export type GradeClientResult =
  | { ok: true; response: GradeResponse }
  | { ok: false; code: GradeErrorCode; message: string; retryable: boolean };

export type GradeTransport = (request: GradeRequest) => Promise<GradeClientResult>;

export function gradeFailure(code: GradeErrorCode): GradeClientResult {
  const { error, retryable } = GRADE_ERRORS[code];
  return { ok: false, code, message: error, retryable };
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(ms)
    : undefined;
}

export async function requestGrade(
  request: GradeRequest,
  fetchImpl: typeof fetch = fetch,
  options: { timeoutMs?: number } = {},
): Promise<GradeClientResult> {
  let res: Response;
  try {
    res = await fetchImpl(GRADE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      cache: "no-store",
      signal: timeoutSignal(options.timeoutMs ?? CLIENT_GRADE_TIMEOUT_MS),
    });
  } catch {
    return gradeFailure("GRADING_UNAVAILABLE");
  }

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  if (!res.ok) {
    // Show a message chosen by code from our own table, never one we were sent.
    const code =
      typeof json === "object" && json !== null && isGradeErrorCode((json as { code?: unknown }).code)
        ? ((json as { code: GradeErrorCode }).code)
        : "GRADING_UNAVAILABLE";
    return gradeFailure(code);
  }

  const response = parseGradeResponse(json, {
    conceptId: request.concept.id,
    itemId: request.item.id,
  });
  if (!response) return gradeFailure("GRADING_UNAVAILABLE");
  return { ok: true, response };
}
