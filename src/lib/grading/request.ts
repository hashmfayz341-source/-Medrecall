import type {
  Concept,
  ConceptStatus,
  RetrievalItem,
  RetrievalKind,
  SourceRef,
} from "@/lib/domain/types";
import { isValidGradeResult, normalize, type GradeResult } from "./index";

/**
 * The wire contract between the browser and POST /api/grade.
 *
 * Curriculum is still browser-local, so the server cannot look a concept up by
 * id. Instead the client sends the NARROW slice needed to grade one attempt —
 * the concept's identity, wording, status and provenance, the one retrieval
 * item being answered, and the answer. Nothing else.
 *
 * There is no field for a prompt, instructions, a model name or provider
 * options: the server decides how to grade. Unknown keys at any level are
 * rejected rather than ignored, so a client cannot smuggle extra input in.
 *
 * Framework-free and provider-free on purpose: the browser, the route and the
 * tests all use this same module.
 */

export interface GradingConcept {
  id: string;
  courseId: string;
  lectureId: string;
  title: string;
  summary: string;
  status: ConceptStatus;
  source: SourceRef;
}

export interface GradeRequest {
  concept: GradingConcept;
  item: RetrievalItem;
  answer: string;
}

export interface GradeResponse {
  /** Which provider produced the assessment. Informational only. */
  provider: string;
  conceptId: string;
  itemId: string;
  grade: GradeResult;
  /** Source-grounded re-teaching. Present exactly when the grade is not CORRECT. */
  remediation: string | null;
}

export const GRADE_REQUEST_LIMITS = {
  /** Whole request body, in characters. */
  maxBodyChars: 256_000,
  maxAnswerChars: 4_000,
  maxIdChars: 300,
  maxTitleChars: 500,
  /** Summary, excerpt, prompt and explanation. Ingested sentences can be long. */
  maxTextChars: 20_000,
  maxKeywordGroups: 50,
  maxTermsPerGroup: 50,
  maxTermChars: 500,
  maxAcceptableAnswers: 50,
  maxAcceptableAnswerChars: 2_000,
  maxRemediationChars: 30_000,
} as const;

const L = GRADE_REQUEST_LIMITS;

const RETRIEVAL_KINDS: readonly RetrievalKind[] = [
  "BASIC",
  "CLOZE",
  "MECHANISM",
  "FREE_RECALL",
  "CLINICAL",
  "IMAGE",
];
const CONCEPT_STATUSES: readonly ConceptStatus[] = ["DRAFT", "ACTIVE", "DISCARDED"];

/**
 * Why a request was refused. Each code maps to a fixed, user-safe message on
 * the server; nothing from the request is echoed back.
 */
export type GradeRequestError =
  | "INVALID_REQUEST"
  | "CONCEPT_NOT_ACTIVE"
  | "ITEM_CONCEPT_MISMATCH"
  | "MISSING_SOURCE"
  | "EMPTY_ANSWER"
  | "ANSWER_TOO_LONG";

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: GradeRequestError };

/** Build the payload for one attempt from the learner's local curriculum. */
export function toGradeRequest(
  concept: Concept,
  item: RetrievalItem,
  answer: string,
): GradeRequest {
  return {
    concept: {
      id: concept.id,
      courseId: concept.courseId,
      lectureId: concept.lectureId,
      title: concept.title,
      summary: concept.summary,
      status: concept.status,
      source: {
        courseId: concept.source.courseId,
        lectureId: concept.source.lectureId,
        documentId: concept.source.documentId,
        pageNumber: concept.source.pageNumber,
        excerpt: concept.source.excerpt,
      },
    },
    item: {
      id: item.id,
      conceptId: item.conceptId,
      kind: item.kind,
      prompt: item.prompt,
      requiredKeywords: item.requiredKeywords.map((group) => [...group]),
      acceptableAnswers: [...item.acceptableAnswers],
      explanation: item.explanation,
    },
    answer,
  };
}

/* ------------------------------------------------------------------ */
/* Strict parsing                                                      */
/* ------------------------------------------------------------------ */

class Reject extends Error {
  constructor(readonly code: GradeRequestError) {
    super(code);
  }
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Reject("INVALID_REQUEST");
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!keys.includes(key)) throw new Reject("INVALID_REQUEST");
  }
  return obj;
}

function text(value: unknown, max: number, { allowEmpty = false } = {}): string {
  if (typeof value !== "string" || value.length > max) {
    throw new Reject("INVALID_REQUEST");
  }
  if (!allowEmpty && value.trim().length === 0) throw new Reject("INVALID_REQUEST");
  return value;
}

function id(value: unknown): string {
  const s = text(value, L.maxIdChars);
  // Identifiers never contain whitespace or control characters.
  if (/[\s\u0000-\u001f\u007f]/.test(s)) throw new Reject("INVALID_REQUEST");
  return s;
}

/**
 * Rubric lists. Empty strings are allowed: `gradeAnswer` already ignores them,
 * and a human edit can legitimately produce one. Rejecting them here would
 * leave an approved concept that can never be graded.
 */
function stringList(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Reject("INVALID_REQUEST");
  }
  return value.map((v) => text(v, maxChars, { allowEmpty: true }));
}

function parseSource(value: unknown): SourceRef {
  if (value === undefined || value === null) throw new Reject("MISSING_SOURCE");
  const obj = record(value, ["courseId", "lectureId", "documentId", "pageNumber", "excerpt"]);
  const pageNumber = obj.pageNumber;
  if (typeof pageNumber !== "number" || !Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new Reject("MISSING_SOURCE");
  }
  const excerpt = obj.excerpt;
  if (typeof excerpt !== "string" || excerpt.trim().length === 0) {
    throw new Reject("MISSING_SOURCE");
  }
  return {
    courseId: id(obj.courseId),
    lectureId: id(obj.lectureId),
    documentId: id(obj.documentId),
    pageNumber,
    excerpt: text(excerpt, L.maxTextChars),
  };
}

function parseConcept(value: unknown): GradingConcept {
  const obj = record(value, [
    "id",
    "courseId",
    "lectureId",
    "title",
    "summary",
    "status",
    "source",
  ]);
  const status = obj.status;
  if (typeof status !== "string" || !CONCEPT_STATUSES.includes(status as ConceptStatus)) {
    throw new Reject("INVALID_REQUEST");
  }
  const concept: GradingConcept = {
    id: id(obj.id),
    courseId: id(obj.courseId),
    lectureId: id(obj.lectureId),
    title: text(obj.title, L.maxTitleChars),
    summary: text(obj.summary, L.maxTextChars),
    status: status as ConceptStatus,
    source: parseSource(obj.source),
  };
  // Provenance must point back into the same course and lecture.
  if (
    concept.source.courseId !== concept.courseId ||
    concept.source.lectureId !== concept.lectureId
  ) {
    throw new Reject("MISSING_SOURCE");
  }
  return concept;
}

function parseItem(value: unknown): RetrievalItem {
  const obj = record(value, [
    "id",
    "conceptId",
    "kind",
    "prompt",
    "requiredKeywords",
    "acceptableAnswers",
    "explanation",
  ]);
  const kind = obj.kind;
  if (typeof kind !== "string" || !RETRIEVAL_KINDS.includes(kind as RetrievalKind)) {
    throw new Reject("INVALID_REQUEST");
  }
  const groups = obj.requiredKeywords;
  if (!Array.isArray(groups) || groups.length > L.maxKeywordGroups) {
    throw new Reject("INVALID_REQUEST");
  }
  return {
    id: id(obj.id),
    conceptId: id(obj.conceptId),
    kind: kind as RetrievalKind,
    prompt: text(obj.prompt, L.maxTextChars),
    requiredKeywords: groups.map((g) => stringList(g, L.maxTermsPerGroup, L.maxTermChars)),
    acceptableAnswers: stringList(
      obj.acceptableAnswers,
      L.maxAcceptableAnswers,
      L.maxAcceptableAnswerChars,
    ),
    explanation: text(obj.explanation, L.maxTextChars, { allowEmpty: true }),
  };
}

/**
 * Validate an untrusted grading request.
 *
 * Order matters for the error code, not for safety: every path that is not a
 * fully valid request for an ACTIVE concept is a rejection.
 */
export function parseGradeRequest(value: unknown): ParseResult<GradeRequest> {
  try {
    const obj = record(value, ["concept", "item", "answer"]);

    const answer = obj.answer;
    if (typeof answer !== "string") throw new Reject("INVALID_REQUEST");
    if (answer.length > L.maxAnswerChars) throw new Reject("ANSWER_TOO_LONG");
    if (answer.trim().length === 0) throw new Reject("EMPTY_ANSWER");

    const concept = parseConcept(obj.concept);
    // The approval gate at the network boundary. DRAFT and DISCARDED concepts
    // are never graded, whoever is asking.
    if (concept.status !== "ACTIVE") throw new Reject("CONCEPT_NOT_ACTIVE");

    const item = parseItem(obj.item);
    if (item.conceptId !== concept.id) throw new Reject("ITEM_CONCEPT_MISMATCH");

    return { ok: true, value: { concept, item, answer } };
  } catch (cause) {
    if (cause instanceof Reject) return { ok: false, error: cause.code };
    return { ok: false, error: "INVALID_REQUEST" };
  }
}

/**
 * Validate the server's reply in the browser before anything acts on it.
 *
 * The reply must be for the exact concept and item that were submitted, carry
 * a structurally valid grade whose normalizedAnswer is the normalization of
 * the submitted answer, and include remediation exactly when the answer was
 * not fully correct. Anything else is treated as a failed request.
 */
export function parseGradeResponse(
  value: unknown,
  expected: { conceptId: string; itemId: string; answer?: string },
): GradeResponse | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.provider !== "string" || v.provider.length === 0 || v.provider.length > 100) {
    return null;
  }
  if (v.conceptId !== expected.conceptId || v.itemId !== expected.itemId) return null;
  if (!isValidGradeResult(v.grade)) return null;
  const grade = v.grade;
  // The normalized answer must be MedRecall's own normalization of what this
  // browser sent — never provider text.
  if (expected.answer !== undefined && grade.normalizedAnswer !== normalize(expected.answer)) {
    return null;
  }

  const remediation = v.remediation;
  if (grade.outcome === "CORRECT") {
    if (remediation !== null) return null;
  } else if (
    typeof remediation !== "string" ||
    remediation.trim().length === 0 ||
    remediation.length > L.maxRemediationChars
  ) {
    return null;
  }

  return {
    provider: v.provider,
    conceptId: expected.conceptId,
    itemId: expected.itemId,
    grade: {
      outcome: grade.outcome,
      correct: grade.correct,
      matched: [...grade.matched],
      missing: [...grade.missing],
      normalizedAnswer: grade.normalizedAnswer,
    },
    remediation: remediation as string | null,
  };
}

