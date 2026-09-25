import { assertActive } from "@/lib/domain/gate";
import { normalize } from "@/lib/domain/text";
import type { RetrievalItem } from "@/lib/domain/types";
import type { GradeResult } from "./index";
import type { GradingConcept } from "./request";

/**
 * Learner-facing remediation, assembled deterministically from reviewed
 * material only.
 *
 * A grader — deterministic today, a model later — decides WHETHER remediation
 * is needed (the outcome) and WHICH of the item's own rubric terms were
 * missed. It never writes the medical content. That content is exactly:
 *
 *   1. a fixed sentence naming missed terms, restricted to terms that already
 *      exist in this item's reviewed rubric;
 *   2. the item's reviewed explanation;
 *   3. the concept's verbatim SourceRef excerpt, with document and page.
 *
 * Nothing a provider writes as free text can reach the learner through here.
 * This is deliberately stronger than checking that a model's paragraph
 * "contains" the excerpt: a paragraph can quote the source and still add
 * invented medicine around it.
 */

export interface RemediationInput {
  concept: GradingConcept;
  item: RetrievalItem;
  grade: GradeResult;
}

/**
 * Restrict grader-reported terms to the item's own reviewed vocabulary:
 * rubric synonyms and accepted answers. A term that matches exactly is kept
 * as-is; one that matches after normalisation is replaced by the reviewed
 * spelling; anything else is dropped. The result is de-duplicated, keeping the
 * first occurrence, so a grader cannot repeat a term. Empty strings (a
 * deterministic artefact of an empty keyword group) pass through once and are
 * never displayed.
 */
export function restrictToReviewedTerms(terms: readonly string[], item: RetrievalItem): string[] {
  const reviewed = [...item.requiredKeywords.flat(), ...item.acceptableAnswers];
  const exact = new Set(reviewed);
  const canonical = new Map<string, string>();
  for (const term of reviewed) {
    const key = normalize(term);
    if (key && !canonical.has(key)) canonical.set(key, term);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const keep = (term: string) => {
    if (seen.has(term)) return;
    seen.add(term);
    out.push(term);
  };
  for (const term of terms) {
    if (term === "" || exact.has(term)) {
      keep(term);
      continue;
    }
    const match = canonical.get(normalize(term));
    if (match !== undefined) keep(match);
  }
  return out;
}

export function composeRemediation(input: RemediationInput): string {
  const { concept, item, grade } = input;
  assertActive(concept, "teaching");
  const missing = restrictToReviewedTerms(grade.missing, item).filter(Boolean);
  const gap =
    missing.length > 0
      ? `Your answer did not mention: ${missing.join(", ")}.`
      : "Your answer was close, but incomplete.";
  return [
    gap,
    item.explanation,
    `Source: ${concept.source.documentId}, page ${concept.source.pageNumber} — "${concept.source.excerpt}"`,
  ].join("\n\n");
}

/**
 * Provenance check: the text quotes the concept's verbatim source excerpt.
 *
 * This is a QUOTE check, not a grounding guarantee — it cannot tell whether
 * anything else in the text is supported by the source. It is only used as a
 * tripwire on `composeRemediation()` output, which is grounded by
 * construction; it must never be used to admit free-form prose.
 */
export function quotesSourceExcerpt(text: string, excerpt: string): boolean {
  const quote = excerpt.trim();
  return quote.length > 0 && text.includes(quote);
}
