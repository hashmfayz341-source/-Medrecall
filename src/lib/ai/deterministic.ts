import { gradeAnswer, type GradeResult } from "@/lib/grading";
import { generateCandidates } from "@/lib/ingestion/extractor";
import { assertActive, assertAllActive } from "@/lib/domain/gate";
import type { Concept, RetrievalItem } from "@/lib/domain/types";
import { composeRemediation } from "@/lib/grading/remediation";
import type { GradingConcept } from "@/lib/grading/request";
import type {
  AiProvider,
  ExtractConceptsInput,
  GradeFreeAnswerInput,
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
  readonly hosted = false;

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
    assertAllActive(input.concepts, "teaching");
    return input.concepts.map((concept) => concept.summary).join("\n\n");
  }

  async generateRetrievalItems(concept: Concept): Promise<RetrievalItem[]> {
    assertActive(concept, "retrieval");
    return concept.retrievalItems;
  }

  /** Keyword-rubric grading. Uses only the item; the concept is not needed. */
  async gradeFreeAnswer(input: GradeFreeAnswerInput): Promise<GradeResult> {
    return gradeAnswer(input.item, input.answer);
  }

  /**
   * The reviewed-material remediation text. Not part of AiProvider: remediation
   * is never provider-written. Kept on this class for existing callers; it is
   * exactly `composeRemediation()`.
   */
  async generateRemediation(input: {
    concept: GradingConcept;
    item: RetrievalItem;
    grade: GradeResult;
    learnerAnswer?: string;
  }): Promise<string> {
    return composeRemediation(input);
  }
}
