import { pathologyCurriculum } from "@/lib/content/pathology";
import { gradeAnswer, type GradeResult } from "@/lib/grading";
import type { Concept, RetrievalItem } from "@/lib/domain/types";
import type {
  AiProvider,
  ExtractConceptsInput,
  RemediationInput,
  TeachingInput,
} from "./provider";

/**
 * The Milestone 1 provider: authored, deterministic, no API key, no network.
 *
 * It implements the same interface a model-backed provider will, so swapping
 * one in later is a single binding change in `getProvider()` — and this
 * implementation stays as the offline fallback and the test oracle.
 */
export class DeterministicProvider implements AiProvider {
  readonly name = "deterministic";

  /** Returns the authored concepts for a document, as DRAFT candidates. */
  async extractConcepts(input: ExtractConceptsInput): Promise<Concept[]> {
    return pathologyCurriculum.concepts
      .filter(
        (c) =>
          c.lectureId === input.lectureId &&
          c.source.documentId === input.document.id,
      )
      .map((c) => ({ ...c, status: "DRAFT" as const }));
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
