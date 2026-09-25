import { normalize } from "@/lib/domain/text";
export { normalize } from "@/lib/domain/text";
import type { RetrievalItem } from "@/lib/domain/types";

/**
 * Deterministic free-recall grading.
 *
 * Milestone 1 runs with no AI key, so grading must be explainable and
 * repeatable: the same answer always produces the same verdict. Each retrieval
 * item declares keyword groups; the learner must hit at least one synonym from
 * every group. That rewards recalling the mechanism rather than matching a
 * sentence word for word.
 *
 * `gradeFreeAnswer()` on the AI provider interface can later replace this with
 * a model-graded path, but this stays the fallback and the test oracle.
 */

/**
 * The assessment verdict.
 *
 * PARTIAL exists so a model-backed grader can express "some of the mechanism,
 * not all of it" without being forced into a binary. The deterministic grader
 * never emits it, and the engine does not yet give it any credit: until the
 * PARTIAL mastery policy lands, it is treated exactly like INCORRECT.
 */
export type GradeOutcome = "INCORRECT" | "PARTIAL" | "CORRECT";

export const GRADE_OUTCOMES: readonly GradeOutcome[] = ["INCORRECT", "PARTIAL", "CORRECT"];

export interface GradeResult {
  outcome: GradeOutcome;
  /**
   * Compatibility view of `outcome`. True ONLY when outcome is "CORRECT" — a
   * PARTIAL answer is never `correct`.
   */
  correct: boolean;
  /**
   * Reviewed rubric terms (or accepted answers) the grader found in the
   * answer. Explanatory metadata only: the OUTCOME alone drives mastery and
   * FSRS. At the server boundary this is restricted to the item's own reviewed
   * vocabulary and de-duplicated.
   */
  matched: string[];
  /**
   * Reviewed rubric terms the grader judged absent. Used only to name missed
   * terms in the deterministic remediation. Restricted to the item's reviewed
   * vocabulary and de-duplicated at the server boundary.
   *
   * Contract: a CORRECT grade has NO missing terms — "correct" and "required
   * information is missing" cannot both be true, and such a grade is rejected
   * at every boundary. INCORRECT and PARTIAL are not further constrained: a
   * semantic grader may judge an answer insufficient even when every keyword
   * appears, or sufficient-in-part with few keywords.
   */
  missing: string[];
  /**
   * `normalize(answer)`. Always computed by MedRecall itself: the server
   * overwrites whatever a provider returns here, and the browser checks it
   * against its own answer, so no provider-written text travels in it.
   */
  normalizedAnswer: string;
}

/** Word-boundary-aware containment, so "atp" does not match "atpase". */
export function containsTerm(haystack: string, term: string): boolean {
  const needle = normalize(term);
  if (needle.length === 0) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(haystack);
}

export function gradeAnswer(item: RetrievalItem, answer: string): GradeResult {
  const normalized = normalize(answer);

  if (normalized.length === 0) {
    return {
      outcome: "INCORRECT",
      correct: false,
      matched: [],
      missing: item.requiredKeywords.map((group) => group[0] ?? ""),
      normalizedAnswer: normalized,
    };
  }

  // Fast path: the learner reproduced an accepted answer outright.
  for (const accepted of item.acceptableAnswers) {
    if (normalized === normalize(accepted)) {
      return {
        outcome: "CORRECT",
        correct: true,
        matched: [accepted],
        missing: [],
        normalizedAnswer: normalized,
      };
    }
  }

  const matched: string[] = [];
  const missing: string[] = [];

  for (const group of item.requiredKeywords) {
    const hit = group.find((term) => containsTerm(normalized, term));
    if (hit) {
      matched.push(hit);
    } else {
      missing.push(group[0] ?? "");
    }
  }

  const correct = missing.length === 0 && item.requiredKeywords.length > 0;
  return {
    outcome: correct ? "CORRECT" : "INCORRECT",
    correct,
    matched,
    missing,
    normalizedAnswer: normalized,
  };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/** Bounds on a grade that crosses a trust boundary (provider or network). */
export const GRADE_LIMITS = {
  maxTerms: 100,
  maxTermChars: 500,
  maxNormalizedAnswerChars: 8_000,
} as const;

function isBoundedStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= GRADE_LIMITS.maxTerms &&
    value.every((v) => typeof v === "string" && v.length <= GRADE_LIMITS.maxTermChars)
  );
}

/**
 * Structural check for a GradeResult that did not come from `gradeAnswer`
 * in this process: a provider's output on the server, or the server's reply in
 * the browser.
 *
 * It rejects anything the engine cannot safely act on — an unknown outcome,
 * a `correct` flag that disagrees with `outcome` (which would otherwise let a
 * malformed PARTIAL be credited as a success), and a CORRECT outcome that
 * still lists missing terms.
 */
export function isValidGradeResult(value: unknown): value is GradeResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.outcome !== "string" || !GRADE_OUTCOMES.includes(v.outcome as GradeOutcome)) {
    return false;
  }
  if (typeof v.correct !== "boolean") return false;
  if (v.correct !== (v.outcome === "CORRECT")) return false;
  if (!isBoundedStringArray(v.matched) || !isBoundedStringArray(v.missing)) return false;
  // A CORRECT answer cannot also be missing required information (L-2).
  if (v.outcome === "CORRECT" && v.missing.length > 0) return false;
  if (
    typeof v.normalizedAnswer !== "string" ||
    v.normalizedAnswer.length > GRADE_LIMITS.maxNormalizedAnswerChars
  ) {
    return false;
  }
  return true;
}

/** Copy only the known GradeResult fields, dropping anything extra. */
export function sanitizeGradeResult(grade: GradeResult): GradeResult {
  return {
    outcome: grade.outcome,
    correct: grade.correct,
    matched: [...grade.matched],
    missing: [...grade.missing],
    normalizedAnswer: grade.normalizedAnswer,
  };
}
