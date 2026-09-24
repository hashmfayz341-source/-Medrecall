/** Raised when a non-ACTIVE Concept is pushed into the learning system. */
export class ConceptNotActiveError extends Error {
  readonly conceptId: string;
  readonly status: string;
  readonly stage: string;

  constructor(conceptId: string, status: string, stage: string) {
    super(
      `Concept "${conceptId}" has status ${status} and cannot enter ${stage}. ` +
        `Only ACTIVE concepts may be taught, tested, scheduled or interleaved.`,
    );
    this.name = "ConceptNotActiveError";
    this.conceptId = conceptId;
    this.status = status;
    this.stage = stage;
  }
}

/** Raised when a lecture is entered before its prerequisites are complete. */
export class LectureLockedError extends Error {
  readonly lectureId: string;

  constructor(lectureId: string, reason: string) {
    super(`Lecture "${lectureId}" is locked: ${reason}`);
    this.name = "LectureLockedError";
    this.lectureId = lectureId;
  }
}

/**
 * Raised when a grade handed to the engine is not something it can act on:
 * wrong shape, unknown outcome, or a `correct` flag that contradicts the
 * outcome. Thrown before any state is touched.
 */
export class InvalidGradeError extends Error {
  constructor(reason: string) {
    super(`Refusing to record an invalid grade: ${reason}`);
    this.name = "InvalidGradeError";
  }
}

/** Raised when a retrieval item does not belong to the concept it is asked for. */
export class ItemConceptMismatchError extends Error {
  readonly conceptId: string;
  readonly itemId: string;

  constructor(conceptId: string, itemId: string) {
    super(`Retrieval item "${itemId}" does not belong to concept "${conceptId}"`);
    this.name = "ItemConceptMismatchError";
    this.conceptId = conceptId;
    this.itemId = itemId;
  }
}
