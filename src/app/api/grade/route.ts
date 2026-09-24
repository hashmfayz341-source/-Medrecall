import { NextResponse } from "next/server";
import { getProvider } from "@/lib/ai";
import { gradeWithProvider } from "@/lib/ai/grade";
import { GRADE_REQUEST_LIMITS, parseGradeRequest } from "@/lib/grading/request";
import {
  GRADE_ERRORS,
  gradingFailureStatus,
  type GradeErrorCode,
} from "@/lib/grading/errors";

/**
 * POST /api/grade — the grading boundary.
 *
 * The browser sends one attempt; the server runs the AI provider and returns
 * a validated assessment. The provider decides the verdict and the
 * re-teaching text. It never sees, and this route never returns, learner
 * state: applying the grade to mastery and FSRS is the deterministic engine's
 * job, done by the caller only after this responds successfully.
 *
 * Provider keys (when a hosted provider exists) stay here, server-side.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 30;

function reject(code: GradeErrorCode, status?: number) {
  const { status: defaultStatus, error, retryable } = GRADE_ERRORS[code];
  return NextResponse.json(
    { code, error, retryable },
    { status: status ?? defaultStatus, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > GRADE_REQUEST_LIMITS.maxBodyChars * 4) return reject("REQUEST_TOO_LARGE");

  let body: string;
  try {
    body = await request.text();
  } catch {
    return reject("INVALID_REQUEST");
  }
  if (body.length > GRADE_REQUEST_LIMITS.maxBodyChars) return reject("REQUEST_TOO_LARGE");

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return reject("INVALID_REQUEST");
  }

  const parsed = parseGradeRequest(json);
  if (!parsed.ok) return reject(parsed.error);
  const { concept, item } = parsed.value;

  let outcome;
  try {
    outcome = await gradeWithProvider(getProvider(), parsed.value);
  } catch (cause) {
    console.error(
      `[grade] unexpected failure concept=${concept.id} item=${item.id}`,
      cause,
    );
    return reject("GRADING_UNAVAILABLE", 500);
  }

  if (!outcome.ok) {
    // The learner's answer is not logged.
    console.error(
      `[grade] provider failure reason=${outcome.failure} concept=${concept.id} item=${item.id}`,
    );
    return reject("GRADING_UNAVAILABLE", gradingFailureStatus(outcome.failure));
  }

  return NextResponse.json(outcome.response, {
    headers: { "Cache-Control": "no-store" },
  });
}
