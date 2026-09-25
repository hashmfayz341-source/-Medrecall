/**
 * MedRecall domain types.
 *
 * The CONCEPT is the central entity. Questions ("retrieval items") are
 * representations of a Concept, never independent knowledge objects.
 *
 * Nothing in this file imports React, Next, or any storage mechanism.
 * The domain layer is pure and framework-free by design.
 */

/** Concept lifecycle. Only ACTIVE concepts may enter the learning system. */
export type ConceptStatus = "DRAFT" | "ACTIVE" | "DISCARDED";

/**
 * Coarse mastery buckets. Deliberately NOT a percentage: a precise-looking
 * number would imply a measurement precision we do not have.
 */
export type MasteryState = "NEW" | "LEARNING" | "WEAK" | "STABLE" | "STRONG";

/** The retrieval forms a single Concept can be tested through. */
export type RetrievalKind =
  | "BASIC"
  | "CLOZE"
  | "MECHANISM"
  | "FREE_RECALL"
  | "CLINICAL"
  | "IMAGE";

/** Why a retrieval item is being asked right now. Drives mastery transitions. */
export type RetrievalContext =
  | "INITIAL"
  | "IMMEDIATE_REMEDIATION"
  | "SPACED"
  | "INTERLEAVED";

export type ConceptImportance = "CORE" | "SUPPORTING";

/**
 * Provenance. Every Concept carries one. A Concept that cannot point back at
 * the page it came from is not allowed to exist.
 */
export interface SourceRef {
  courseId: string;
  lectureId: string;
  documentId: string;
  pageNumber: number;
  /** Verbatim excerpt from the source page. Powers a future "View Source". */
  excerpt: string;
}

export interface Page {
  number: number;
  title: string;
  text: string;
}

export interface SourceDocument {
  id: string;
  lectureId: string;
  title: string;
  pages: Page[];
}

export interface RetrievalItem {
  id: string;
  conceptId: string;
  kind: RetrievalKind;
  prompt: string;
  /** Deterministic grading: the answer must contain these concept keywords. */
  requiredKeywords: string[][];
  /** Any one of these alone is a full-credit answer (exact-ish match path). */
  acceptableAnswers: string[];
  explanation: string;
}

export interface Concept {
  id: string;
  courseId: string;
  lectureId: string;
  title: string;
  /** One-line statement of the idea. */
  summary: string;
  importance: ConceptImportance;
  status: ConceptStatus;
  /** Concept ids that should be understood first. */
  prerequisiteIds: string[];
  source: SourceRef;
  retrievalItems: RetrievalItem[];
}

/**
 * A teaching step: a small, source-grounded run of pages (2-5) plus the
 * explanation and the concepts it introduces.
 */
export interface TeachingChunk {
  id: string;
  lectureId: string;
  order: number;
  title: string;
  documentId: string;
  pageNumbers: number[];
  conceptIds: string[];
  explanation: string;
  /**
   * True when this chunk was assembled from an ingested document rather than
   * authored by a human.
   *
   * Generated prose and generated pages are made of candidate sentences, so
   * the tutor must rebuild them from ACTIVE concepts only. Authored chunks are
   * human-written teaching material and are served as written.
   */
  generated?: boolean;
}

export interface Lecture {
  id: string;
  courseId: string;
  title: string;
  order: number;
  documents: SourceDocument[];
  chunks: TeachingChunk[];
}

export interface Course {
  id: string;
  title: string;
  description: string;
  lectures: Lecture[];
}

/**
 * Shared curriculum state: authored/extracted content plus concept status.
 * Kept separate from learner state so a future release can move this to a
 * server without touching per-learner records.
 */
export interface Curriculum {
  course: Course;
  concepts: Concept[];
}

/** Serialized FSRS card. Mirrors ts-fsrs `Card` with ISO date strings. */
export interface ScheduleState {
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: number;
  last_review?: string;
}

/** Per-learner record for one Concept. */
export interface ConceptProgress {
  conceptId: string;
  mastery: MasteryState;
  /** Successes in a SPACED or INTERLEAVED context since the last failure. */
  consecutiveSpacedSuccesses: number;
  totalAttempts: number;
  totalCorrect: number;
  /** True once the learner has ever answered this concept incorrectly. */
  everWrong: boolean;
  /**
   * True when the learner passed a remediation check immediately after being
   * shown the explanation. Explicitly does NOT clear WEAK.
   */
  immediateRemediationPassed: boolean;
  lastAttemptAt: string | null;
  schedule: ScheduleState;
}

/**
 * An Anki-style self-rating, chosen by the learner after seeing the answer.
 * Maps one-to-one onto FSRS ratings — Easy is never collapsed into Good.
 */
export type SelfRating = "AGAIN" | "HARD" | "GOOD" | "EASY";

/**
 * Per-learner record for one STUDY CARD — a RetrievalItem studied on its own.
 *
 * FSRS schedules each card individually, exactly as Anki schedules each card
 * of a note. The Concept the card represents keeps its own ConceptProgress
 * (mastery), which every card of that concept feeds.
 */
export interface CardProgress {
  itemId: string;
  conceptId: string;
  schedule: ScheduleState;
  /** Number of self-ratings recorded for this card. */
  reviews: number;
  lastRating: SelfRating | null;
  lastReviewedAt: string | null;
}

/** Per-learner state. Everything the tutor knows about one student. */
export interface LearnerState {
  version: number;
  progress: Record<string, ConceptProgress>;
  /** Teaching chunk ids whose explanation the learner has already read. */
  taughtChunkIds: string[];
  /** Teaching chunk ids the learner has completed. */
  completedChunkIds: string[];
  /** Lecture ids the learner has finished. */
  completedLectureIds: string[];
  /** Interleaved concept ids already injected, keyed by chunk id. */
  injectedByChunk: Record<string, string[]>;
  /**
   * Study-card progress keyed by RetrievalItem id. Optional so learner state
   * saved before card study existed loads unchanged; absent means no card has
   * been studied yet.
   */
  cards?: Record<string, CardProgress>;
}
