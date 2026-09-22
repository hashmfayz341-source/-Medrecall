import { normalize } from "@/lib/domain/text";
import { buildRetrievalItems } from "@/lib/domain/retrieval";
export { buildRetrievalItems } from "@/lib/domain/retrieval";
import type {
  Concept,
  ConceptImportance,
  Page,
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

    const text = page.text.startsWith(`${page.title}\n`)
      ? page.text.slice(page.title.length + 1)
      : page.text;
    for (const sentence of splitSentences(text)) {
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

    // Deliberately provenance only. Embedding the candidate sentences here is
    // how unapproved text reached teaching in Milestone 2: the chunk is built
    // while every candidate is still DRAFT. The tutor composes the body from
    // ACTIVE concepts at serve time instead.
    return {
      id: `${doc.id}-chunk-${index + 1}`,
      lectureId,
      order: orderOffset + index + 1,
      title: pages[0]?.title ?? `Part ${index + 1}`,
      documentId: doc.id,
      pageNumbers,
      conceptIds: chunkConcepts.map((c) => c.id),
      generated: true,
      explanation: `From ${doc.title}, ${range}${headings ? ` (${headings})` : ""}.`,
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
