import { gradeAnswer, type GradeResult } from "@/lib/grading";
import { generateCandidates } from "@/lib/ingestion/extractor";
import type { Concept, RetrievalItem } from "@/lib/domain/types";
import type {
  AiProvider,
  ExtractConceptsInput,
  RemediationInput,
  TeachingInput,
} from "./provider";

/**
 * The deterministic provider: authored behaviour, no API key, no network.
 *
 * It implements the same interface a model-backed provider will, so swapping
 * one in later is a single binding change in `getProvider()` — and this
 * implementation stays as the offline fallback and the test oracle.
 */
export class DeterministicProvider implements AiProvider {
  readonly name = "deterministic";

  /**
   * Extract candidate concepts from a document's pages.
   *
   * Every concept is DRAFT and carries the page and verbatim sentence it came
   * from. Nothing is asserted that the source does not already say.
   */
  async extractConcepts(input: ExtractConceptsInput): Promise<Concept[]> {
    const { document } = input;
    return generateCandidates(
      {
        id: document.id,
        title: document.title,
        pageCount: document.pages.length,
        pages: document.pages,
      },
      { courseId: input.courseId, lectureId: input.lectureId },
    );
  }

  async generateTeachingExplanation(input: TeachingInput): Promise<string> {
    return input.chunk.explanation;
  }

  async generateRetrievalItems(concept: Concept): Promise<RetrievalItem[]> {
    return concept.retrievalItems;
  }

  async gradeFreeAnswer(
    item: RetrievalItem,
    answer: string,
  ): Promise<GradeResult> {
    return gradeAnswer(item, answer);
  }

  async generateRemediation(input: RemediationInput): Promise<string> {
    const { concept, item, grade } = input;
    const missing = grade.missing.filter(Boolean);
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
}
