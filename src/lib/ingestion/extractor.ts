import type {
  Concept,
  ConceptImportance,
  Page,
  RetrievalItem,
  SourceDocument,
  TeachingChunk,
} from "@/lib/domain/types";
import type { ExtractedDocument } from "./pdf";

/**
 * Deterministic candidate-concept extraction.
 *
 * Hard rule: NOTHING here invents medical content. Every concept title is a
 * span lifted from the source sentence, every explanation IS the source
 * sentence, and every excerpt is that same verbatim text. The extractor
 * decides what to *select*, never what to *assert*.
 *
 * Everything it produces is DRAFT. A human decides what becomes teachable.
 */

/** Words that mark the end of a subject phrase in ordinary medical prose. */
const AUXILIARIES = new Set([
  "is", "are", "was", "were", "has", "have", "can", "may", "must", "will",
  "becomes", "become", "remains", "represents",
]);

const STOPWORDS = new Set([
  "the", "and", "that", "this", "these", "those", "with", "from", "into",
  "within", "which", "when", "than", "then", "their", "there", "they", "them",
  "its", "for", "are", "was", "were", "has", "have", "had", "been", "being",
  "most", "more", "much", "many", "some", "such", "also", "very", "other",
  "because", "about", "after", "before", "between", "during", "through",
  "while", "would", "could", "should", "over", "under", "both", "each",
]);

/** Sentence-level markers that make a statement worth surfacing as CORE. */
const CORE_SIGNALS =
  /\b(most common|hallmark|earliest|defined as|central|key|characteristic|marks the transition|primary)\b/i;

const MAX_CANDIDATES_PER_PAGE = 4;
const MIN_TITLE_WORDS = 1;
const MAX_TITLE_WORDS = 8;

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function words(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

function looksLikeVerb(token: string): boolean {
  const bare = token.toLowerCase().replace(/[^a-z]/g, "");
  if (bare.length === 0) return false;
  if (AUXILIARIES.has(bare)) return true;
  // Third-person singular or past tense: "consumes", "leads", "marks", "led".
  return bare.length >= 4 && /(?:s|ed)$/.test(bare) && !/(?:ss|us|is)$/.test(bare);
}

/**
 * Split a sentence into the thing being described and what is said about it.
 * Returns null when no verb boundary is found — those sentences are skipped
 * rather than guessed at.
 */
export function splitSubjectPredicate(
  sentence: string,
): { subject: string; predicate: string } | null {
  const tokens = words(sentence);
  if (tokens.length < 4) return null;

  for (let i = 1; i < tokens.length - 1; i++) {
    if (looksLikeVerb(tokens[i]!)) {
      const subject = tokens.slice(0, i).join(" ");
      const predicate = tokens.slice(i).join(" ");
      return { subject, predicate };
    }
  }
  return null;
}

/** Tidy a subject phrase into a concept title without changing its meaning. */
export function titleFromSubject(subject: string): string | null {
  const cleaned = subject
    .replace(/^(the|a|an)\s+/i, "")
    .replace(/[,;:]+$/, "")
    .trim();

  const count = words(cleaned).length;
  if (count < MIN_TITLE_WORDS || count > MAX_TITLE_WORDS) return null;
  if (cleaned.length < 3 || cleaned.length > 70) return null;

  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9+/\s-]/g, " ").replace(/\s+/g, " ").trim();
}

function contentKeywords(text: string, limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of words(normalize(text))) {
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
    prompt: clozePrompt === sentence ? `Fill the gap: ___ ${predicate}` : clozePrompt,
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

export interface CandidateOptions {
  courseId: string;
  lectureId: string;
}

/**
 * Turn extracted pages into DRAFT candidate concepts.
 *
 * Prerequisite links are only created when an earlier candidate's title
 * appears verbatim in this candidate's source sentence. That is evidence from
 * the document itself rather than an inference about the subject matter.
 */
export function generateCandidates(
  doc: ExtractedDocument,
  options: CandidateOptions,
): Concept[] {
  const concepts: Concept[] = [];
  const seenTitles = new Set<string>();

  for (const page of doc.pages) {
    let onThisPage = 0;

    for (const sentence of splitSentences(page.text)) {
      if (onThisPage >= MAX_CANDIDATES_PER_PAGE) break;

      const split = splitSubjectPredicate(sentence);
      if (!split) continue;

      const title = titleFromSubject(split.subject);
      if (!title) continue;

      const key = normalize(title);
      if (seenTitles.has(key)) continue;
      seenTitles.add(key);

      const id = `${doc.id}-p${page.number}-c${onThisPage}`;
      const importance: ConceptImportance =
        onThisPage === 0 || CORE_SIGNALS.test(sentence) ? "CORE" : "SUPPORTING";

      // Only link to an earlier concept whose title is literally present here.
      const haystack = normalize(sentence);
      const prerequisiteIds = concepts
        .filter((earlier) => haystack.includes(normalize(earlier.title)))
        .map((earlier) => earlier.id)
        .slice(0, 2);

      concepts.push({
        id,
        courseId: options.courseId,
        lectureId: options.lectureId,
        title,
        summary: sentence,
        importance,
        status: "DRAFT",
        prerequisiteIds,
        source: {
          courseId: options.courseId,
          lectureId: options.lectureId,
          documentId: doc.id,
          pageNumber: page.number,
          excerpt: sentence,
        },
        retrievalItems: buildRetrievalItems(
          id,
          title,
          split.subject,
          split.predicate,
          sentence,
          doc.title,
          page.number,
        ),
      });

      onThisPage++;
    }
  }

  return concepts;
}

/** Balanced page groups, aiming for the 2-5 page teaching chunks of Milestone 1. */
export function chunkPageNumbers(pageNumbers: readonly number[]): number[][] {
  const total = pageNumbers.length;
  if (total === 0) return [];
  const groups = Math.max(1, Math.ceil(total / 3));
  const base = Math.floor(total / groups);
  const extra = total % groups;

  const out: number[][] = [];
  let cursor = 0;
  for (let i = 0; i < groups; i++) {
    const size = base + (i < extra ? 1 : 0);
    out.push(pageNumbers.slice(cursor, cursor + size));
    cursor += size;
  }
  return out;
}

/**
 * Teaching chunks for an ingested document.
 *
 * The explanation is assembled only from the document's own page headings and
 * the verbatim sentences the candidates came from — no generated prose.
 */
export function buildChunks(
  doc: ExtractedDocument,
  lectureId: string,
  concepts: readonly Concept[],
  orderOffset: number,
): TeachingChunk[] {
  const groups = chunkPageNumbers(doc.pages.map((p) => p.number));

  return groups.map((pageNumbers, index) => {
    const pages = doc.pages.filter((p) => pageNumbers.includes(p.number));
    const chunkConcepts = concepts.filter((c) =>
      pageNumbers.includes(c.source.pageNumber),
    );
    const first = pageNumbers[0]!;
    const last = pageNumbers[pageNumbers.length - 1]!;
    const range = first === last ? `page ${first}` : `pages ${first}-${last}`;

    const headings = pages.map((p) => p.title).join(" · ");
    const body = chunkConcepts.map((c) => `• ${c.summary}`).join("\n");

    return {
      id: `${doc.id}-chunk-${index + 1}`,
      lectureId,
      order: orderOffset + index + 1,
      title: pages[0]?.title ?? `Part ${index + 1}`,
      documentId: doc.id,
      pageNumbers,
      conceptIds: chunkConcepts.map((c) => c.id),
      explanation:
        `From ${doc.title}, ${range}${headings ? ` (${headings})` : ""}.\n\n` +
        `The following statements are taken directly from the source:\n${body}`,
    };
  });
}

/** The SourceDocument record stored in shared curriculum state. */
export function toSourceDocument(
  doc: ExtractedDocument,
  lectureId: string,
): SourceDocument {
  return {
    id: doc.id,
    lectureId,
    title: doc.title,
    pages: doc.pages.map((p: Page) => ({ ...p })),
  };
}
