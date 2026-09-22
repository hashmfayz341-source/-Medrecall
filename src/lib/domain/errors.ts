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
