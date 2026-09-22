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

export interface GradeResult {
  correct: boolean;
  /** One representative matched term per satisfied keyword group. */
  matched: string[];
  /** The first synonym of each group the learner missed. */
  missing: string[];
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

  return {
    correct: missing.length === 0 && item.requiredKeywords.length > 0,
    matched,
    missing,
    normalizedAnswer: normalized,
  };
}
