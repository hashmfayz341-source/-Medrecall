import type {
  Concept,
  RetrievalItem,
  SourceDocument,
  TeachingChunk,
} from "@/lib/domain/types";
import type { GradeResult } from "@/lib/grading";
import type { GradingConcept } from "@/lib/grading/request";

/**
 * Provider-agnostic AI surface.
 *
 * MedRecall is not coupled to any one vendor. Anthropic, OpenAI or a local
 * model can each implement this interface; the engine, domain and UI never
 * import a vendor SDK.
 *
 * API keys stay server-side. Implementations that call a hosted model must run
 * inside a route handler or server action — never in a client component.
 */

export interface ExtractConceptsInput {
  courseId: string;
  lectureId: string;
  document: SourceDocument;
}

export interface TeachingInput {
  chunk: TeachingChunk;
  concepts: Concept[];
  pages: SourceDocument["pages"];
}

export interface RemediationInput {
  /**
   * The narrow concept slice the grading boundary carries: identity, wording,
   * status and provenance. A full Concept satisfies it too.
   */
  concept: GradingConcept;
  item: RetrievalItem;
  grade: GradeResult;
  learnerAnswer: string;
}

export interface AiProvider {
  readonly name: string;
  /**
   * Turn source pages into CANDIDATE concepts. Implementations MUST return
   * concepts with status "DRAFT" and a populated SourceRef — extraction never
   * produces something the learner sees unreviewed.
   */
  extractConcepts(input: ExtractConceptsInput): Promise<Concept[]>;
  generateTeachingExplanation(input: TeachingInput): Promise<string>;
  generateRetrievalItems(concept: Concept): Promise<RetrievalItem[]>;
  /**
   * Assess one answer. Decides the verdict ONLY — it never sees or writes
   * learner state. Runs server-side, behind POST /api/grade.
   */
  gradeFreeAnswer(item: RetrievalItem, answer: string): Promise<GradeResult>;
  /**
   * Re-teach after a non-CORRECT answer. Must stay grounded in the concept's
   * verbatim source excerpt; the grading service rejects output that is not.
   */
  generateRemediation(input: RemediationInput): Promise<string>;
}
