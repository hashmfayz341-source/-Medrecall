import type { RetrievalItem } from "./types";
import { normalize } from "./text";

const STOPWORDS = new Set([
  "the", "and", "that", "this", "these", "those", "with", "from", "into",
  "within", "which", "when", "than", "then", "their", "there", "they", "them",
  "its", "for", "are", "was", "were", "has", "have", "had", "been", "being",
  "most", "more", "much", "many", "some", "such", "also", "very", "other",
  "because", "about", "after", "before", "between", "during", "through",
  "while", "would", "could", "should", "over", "under", "both", "each",
]);

function contentKeywords(text: string, limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of normalize(text).split(/\s+/)) {
    if (raw.length < 4 || STOPWORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Build retrieval items for a candidate. Two forms, so the tutor's remediation
 * step can ask a different question from the one just failed.
 */
export function buildRetrievalItems(
  conceptId: string,
  title: string,
  subject: string,
  predicate: string,
  sentence: string,
  documentTitle: string,
  pageNumber: number,
): RetrievalItem[] {
  const titleTerm = normalize(title);
  const subjectTerm = normalize(subject);

  const clozePrompt = sentence.replace(subject, "___");
  const keywords = contentKeywords(predicate, 2);

  const cloze: RetrievalItem = {
    id: `${conceptId}-r1`,
    conceptId,
    kind: "CLOZE",
    prompt: clozePrompt === sentence ? `Which concept is described? ${sentence}` : clozePrompt,
    requiredKeywords: [[titleTerm, subjectTerm].filter((t, i, a) => t && a.indexOf(t) === i)],
    acceptableAnswers: [title, subject],
    explanation: sentence,
  };

  const recall: RetrievalItem = {
    id: `${conceptId}-r2`,
    conceptId,
    kind: "BASIC",
    prompt: `What does ${documentTitle} (page ${pageNumber}) state about ${title}?`,
    requiredKeywords:
      keywords.length > 0
        ? keywords.map((k) => [k])
        : [[titleTerm]],
    acceptableAnswers: [],
    explanation: sentence,
  };

  return [cloze, recall];
}

