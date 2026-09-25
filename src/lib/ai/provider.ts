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
 * inside a route handler or server action — never in a client component — and
 * may not be enabled at all until the safeguards in `./policy.ts` exist.
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

/**
 * Everything a grader may use to assess one answer: the approved concept's
 * identity, wording and verbatim SourceRef excerpt, the retrieval item with
 * its reviewed rubric, and the learner's answer. A model grader grades
 * against this — the source — not against its own knowledge.
 */
export interface GradeFreeAnswerInput {
  concept: GradingConcept;
  item: RetrievalItem;
  answer: string;
}

/** What every provider declares, whatever it does. */
export interface ProviderIdentity {
  readonly name: string;
  /**
   * True when calling this provider costs money or reaches a third party. A
   * hosted provider is refused by `assertProviderPermitted()` until the
   * server-side abuse controls it needs exist (see ./policy.ts).
   */
  readonly hosted: boolean;
}

/**
 * The GRADING role, resolved only by `getGradingProvider()` and used only by
 * POST /api/grade.
 */
export interface GradingProvider extends ProviderIdentity {
  /**
   * Assess one answer. Decides the verdict ONLY: the outcome, and which of the
   * item's own rubric terms were matched or missed. It never sees or writes
   * learner state, and it writes no learner-facing text — remediation is
   * composed deterministically from reviewed material (see
   * `lib/grading/remediation.ts`).
   */
  gradeFreeAnswer(input: GradeFreeAnswerInput): Promise<GradeResult>;
}

/**
 * The EXTRACTION role, resolved only by `getExtractionProvider()` and used only
 * by POST /api/ingest.
 */
export interface ExtractionProvider extends ProviderIdentity {
  /**
   * Turn source pages into CANDIDATE concepts. Implementations MUST return
   * concepts with status "DRAFT" and a populated SourceRef — extraction never
   * produces something the learner sees unreviewed.
   */
  extractConcepts(input: ExtractConceptsInput): Promise<Concept[]>;
}

/**
 * The full surface the deterministic provider implements. Roles are resolved
 * SEPARATELY (see ./gradingProvider.ts and ./extractionProvider.ts): a hosted
 * grader need not, and must not, become the extractor by implementing this.
 */
export interface AiProvider extends GradingProvider, ExtractionProvider {
  generateTeachingExplanation(input: TeachingInput): Promise<string>;
  generateRetrievalItems(concept: Concept): Promise<RetrievalItem[]>;
}
