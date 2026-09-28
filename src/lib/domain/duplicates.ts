import type { Concept, Curriculum } from "./types";
import { normalize } from "./text";

/**
 * Duplicate candidates across documents (Milestone 2 follow-through).
 *
 * The same idea often arrives twice: a summary slide deck and a textbook
 * chapter each yield "Hypoxia is the most common cause of cell injury".
 * Extraction already de-duplicates by title WITHIN a document; across
 * documents (and against the authored course) it cannot, because each upload
 * is extracted on its own. Left alone, both candidates get approved, both are
 * taught, both are scheduled, and the learner is asked the same thing twice.
 *
 * Detection is deterministic and purely textual — no model, nothing invented:
 * two concepts from different documents are suggested as duplicates when
 * their normalised titles are equal, or when their summaries share most of
 * their content words. A suggestion is only ever a suggestion; merging is a
 * reviewer's explicit decision, recorded in the curriculum overrides.
 */

export interface DuplicateSuggestion {
  /** The concept suggested to be folded into `canonicalId`. */
  conceptId: string;
  canonicalId: string;
  reason: "title" | "summary";
  /** 1 for an identical title; the summary word overlap otherwise. */
  similarity: number;
}

const STOPWORDS = new Set([
  "the", "and", "that", "this", "these", "those", "with", "from", "into", "which",
  "when", "than", "then", "their", "there", "they", "them", "its", "for", "are",
  "was", "were", "has", "have", "had", "been", "being", "most", "more", "much",
  "many", "some", "such", "also", "very", "other", "because", "about", "after",
  "before", "between", "during", "through", "while", "would", "could", "should",
  "over", "under", "both", "each", "not", "but", "can", "may", "will", "one",
]);

/** Content words of a text: normalised, at least four letters, not a stopword. */
export function contentWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const word of normalize(text).split(/\s+/)) {
    if (word.length >= 4 && !STOPWORDS.has(word)) words.add(word);
  }
  return words;
}

/** Jaccard overlap of two word sets; 0 when either is empty. */
export function wordOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Summaries this similar are suggested as duplicates. */
export const SUMMARY_DUPLICATE_THRESHOLD = 0.6;

const STATUS_RANK = { ACTIVE: 0, DRAFT: 1, DISCARDED: 2 } as const;

/**
 * Which of two duplicates should survive: an ACTIVE one over a DRAFT one, then
 * the one earlier in the course (lecture order, page, id). Deterministic.
 */
export function preferCanonical(curriculum: Curriculum, a: Concept, b: Concept): [Concept, Concept] {
  const order = (c: Concept) => curriculum.course.lectures.find((l) => l.id === c.lectureId)?.order ?? Number.MAX_SAFE_INTEGER;
  const key = (c: Concept): [number, number, number, string] => [STATUS_RANK[c.status], order(c), c.source.pageNumber, c.id];
  const ka = key(a);
  const kb = key(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i]! < kb[i]!) return [a, b];
    if (ka[i]! > kb[i]!) return [b, a];
  }
  return [a, b];
}

/**
 * Suggested duplicates among the concepts still under review or in use
 * (DRAFT and ACTIVE; DISCARDED ones are already out, merged or not). Each
 * concept appears at most once as the one to fold, against its best match.
 * Concepts from the same document are never paired: extraction has already
 * separated them.
 */
export function findDuplicateCandidates(curriculum: Curriculum): DuplicateSuggestion[] {
  const live = curriculum.concepts.filter((c) => c.status !== "DISCARDED" && !c.mergedInto);
  const words = new Map(live.map((c) => [c.id, contentWords(c.summary)]));
  const titles = new Map(live.map((c) => [c.id, normalize(c.title)]));
  const best = new Map<string, DuplicateSuggestion>();

  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i]!;
      const b = live[j]!;
      if (a.source.documentId === b.source.documentId) continue;
      let reason: DuplicateSuggestion["reason"] | null = null;
      let similarity = 0;
      if (titles.get(a.id) === titles.get(b.id)) {
        reason = "title";
        similarity = 1;
      } else {
        similarity = wordOverlap(words.get(a.id)!, words.get(b.id)!);
        if (similarity >= SUMMARY_DUPLICATE_THRESHOLD) reason = "summary";
      }
      if (!reason) continue;
      const [canonical, duplicate] = preferCanonical(curriculum, a, b);
      const current = best.get(duplicate.id);
      if (!current || similarity > current.similarity) {
        best.set(duplicate.id, { conceptId: duplicate.id, canonicalId: canonical.id, reason, similarity });
      }
    }
  }
  // A canonical is never itself folded into something else in the same pass:
  // the reviewer resolves the chain one merge at a time.
  const canonicals = new Set([...best.values()].map((s) => s.canonicalId));
  return [...best.values()]
    .filter((s) => !canonicals.has(s.conceptId))
    .sort((x, y) => y.similarity - x.similarity || x.conceptId.localeCompare(y.conceptId));
}
