import type {
  Concept,
  RetrievalItem,
  SourceDocument,
  TeachingChunk,
} from "@/lib/domain/types";
import type { GradeResult } from "@/lib/grading";

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
  concept: Concept;
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
  gradeFreeAnswer(item: RetrievalItem, answer: string): Promise<GradeResult>;
  generateRemediation(input: RemediationInput): Promise<string>;
}
