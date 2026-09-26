import { activeOnly, assertActive, isActive } from "@/lib/domain/gate";
import {
  InvalidGradeError,
  ItemConceptMismatchError,
  LectureLockedError,
  StaleAttemptError,
} from "@/lib/domain/errors";
import { applyRetrievalToMastery, createProgress } from "@/lib/domain/mastery";
import {
  gradeAnswer,
  isValidGradeResult,
  sanitizeGradeResult,
  type GradeResult,
} from "@/lib/grading";
import { isDue, newSchedule, scheduleAfterAttempt } from "./scheduler";
import { scoreConcept } from "./priority";
import type {
  Concept,
  ConceptProgress,
  Curriculum,
  LearnerState,
  Lecture,
  Page,
  RetrievalContext,
  RetrievalItem,
  TeachingChunk,
} from "@/lib/domain/types";

export const LEARNER_STATE_VERSION = 1;

export function createLearnerState(): LearnerState {
  return {
    version: LEARNER_STATE_VERSION,
    progress: {},
    taughtChunkIds: [],
    completedChunkIds: [],
    completedLectureIds: [],
    injectedByChunk: {},
  };
}

/* ------------------------------------------------------------------ */
/* Lookups                                                             */
/* ------------------------------------------------------------------ */

export function getConcept(curriculum: Curriculum, conceptId: string): Concept {
  const concept = curriculum.concepts.find((c) => c.id === conceptId);
  if (!concept) throw new Error(`Unknown concept: ${conceptId}`);
  return concept;
}

export function getLecture(curriculum: Curriculum, lectureId: string): Lecture {
  const lecture = curriculum.course.lectures.find((l) => l.id === lectureId);
  if (!lecture) throw new Error(`Unknown lecture: ${lectureId}`);
  return lecture;
}

export function getItem(concept: Concept, itemId: string): RetrievalItem {
  const item = concept.retrievalItems.find((i) => i.id === itemId);
  if (!item) throw new Error(`Unknown retrieval item: ${itemId}`);
  return item;
}

export function pagesForChunk(lecture: Lecture, chunk: TeachingChunk): Page[] {
  const doc = lecture.documents.find((d) => d.id === chunk.documentId);
  if (!doc) return [];
  return doc.pages.filter((p) => chunk.pageNumbers.includes(p.number));
}

/** ACTIVE concepts introduced by a chunk. DRAFT candidates never appear. */
export function conceptsForChunk(
  curriculum: Curriculum,
  chunk: TeachingChunk,
): Concept[] {
  return activeOnly(
    chunk.conceptIds
      .map((id) => curriculum.concepts.find((c) => c.id === id))
      .filter((c): c is Concept => c !== undefined),
  );
}

/** ACTIVE concepts belonging to a lecture. */
export function conceptsForLecture(
  curriculum: Curriculum,
  lectureId: string,
): Concept[] {
  return activeOnly(curriculum.concepts.filter((c) => c.lectureId === lectureId));
}

/**
 * Generated chunk prose is assembled from candidate sentences while every
 * candidate is still DRAFT, so serving it raw leaks unapproved text. Rebuild
 * it from ACTIVE concepts only.
 *
 * Authored chunks are human-written teaching material, not a machine
 * concatenation of candidates, so they are served exactly as written. Their
 * quality is a Milestone 1 product feature and rewriting them here would
 * replace real teaching prose with a list of one-line summaries.
 */
function approvedChunk(curriculum: Curriculum, chunk: TeachingChunk): TeachingChunk {
  if (!chunk.generated) return chunk;

  const concepts = conceptsForChunk(curriculum, chunk);
  const numbers = [...chunk.pageNumbers].sort((a, b) => a - b);
  const first = numbers[0];
  const last = numbers[numbers.length - 1];
  const range =
    first === undefined
      ? ""
      : first === last
        ? `Page ${first}`
        : `Pages ${first}-${last}`;

  // Built from scratch every time. The stored explanation is pre-review prose
  // assembled while every candidate was DRAFT, so it is never a starting
  // point — not even for stores written before the `generated` flag existed.
  const body = concepts.map((c) => `• ${c.summary}`).join("\n");

  return {
    ...chunk,
    // Titles come from approved concepts, or a neutral label. A raw PDF
    // heading is unreviewed source text and never becomes teaching content.
    title: concepts.length > 0 ? concepts.map((c) => c.title).join(" · ") : range || "Part",
    conceptIds: concepts.map((c) => c.id),
    explanation: [range, body].filter((part) => part.length > 0).join("\n\n"),
  };
}

function excludedChunk(curriculum: Curriculum, chunk: TeachingChunk): boolean {
  // A blank page has no learning work. Explicitly discarded candidates are
  // excluded too, but a DRAFT (or missing concept) must still wait for review.
  return chunk.conceptIds.every((id) =>
    curriculum.concepts.find((c) => c.id === id)?.status === "DISCARDED",
  );
}

/* ------------------------------------------------------------------ */
/* Progress helpers                                                    */
/* ------------------------------------------------------------------ */

export function ensureProgress(
  learner: LearnerState,
  conceptId: string,
  now: Date,
): ConceptProgress {
  return learner.progress[conceptId] ?? createProgress(conceptId, newSchedule(now));
}

/**
 * Evidence that the TUTOR has retrieved this concept.
 *
 * Concept mastery (and `totalAttempts`) is shared by the Tutor and Card Study,
 * but the concept-level FSRS schedule is advanced ONLY by Tutor attempts
 * (`scheduleAfterAttempt`); card study keeps its own per-card schedules. So
 * `schedule.reps` counts Tutor retrievals exactly: every Tutor attempt adds
 * one (ts-fsrs: an empty card has reps 0 and each review increments it), and
 * for learner state from before card study existed `reps === totalAttempts`.
 *
 * Anything that asks "did the Tutor's own retrieval happen?" — untested
 * detection, chunk and lecture completion, item rotation, immediate
 * remediation — must use these, never `totalAttempts`.
 */
export function tutorAttemptCount(progress: ConceptProgress | undefined): number {
  return progress?.schedule.reps ?? 0;
}

export function hasTutorAttempt(progress: ConceptProgress | undefined): boolean {
  return tutorAttemptCount(progress) > 0;
}

/**
 * A concept is awaiting immediate Tutor remediation when it is WEAK, has not
 * been worked back through since, and the Tutor has actually retrieved it.
 * A Study-only failure (no Tutor attempt) never triggers a Tutor REMEDIATE:
 * the Tutor still teaches and retrieves that concept normally first.
 */
export function pendingRemediation(progress: ConceptProgress | undefined): boolean {
  if (!progress) return false;
  return (
    hasTutorAttempt(progress) &&
    progress.mastery === "WEAK" &&
    !progress.immediateRemediationPassed
  );
}

/* ------------------------------------------------------------------ */
/* Lecture progression                                                 */
/* ------------------------------------------------------------------ */

export function isLectureUnlocked(
  curriculum: Curriculum,
  learner: LearnerState,
  lectureId: string,
): boolean {
  const lecture = getLecture(curriculum, lectureId);
  const earlier = curriculum.course.lectures.filter((l) => l.order < lecture.order);
  const completed = reconcile(curriculum, learner).completedLectureIds;
  return earlier.every((l) => completed.includes(l.id));
}

export function assertLectureUnlocked(
  curriculum: Curriculum,
  learner: LearnerState,
  lectureId: string,
): void {
  if (!isLectureUnlocked(curriculum, learner, lectureId)) {
    throw new LectureLockedError(
      lectureId,
      "an earlier lecture in this course is not complete yet",
    );
  }
}

function isChunkComplete(
  curriculum: Curriculum,
  learner: LearnerState,
  chunk: TeachingChunk,
): boolean {
  if (!learner.taughtChunkIds.includes(chunk.id)) return false;
  const concepts = conceptsForChunk(curriculum, chunk);
  // A chunk whose candidates are all still DRAFT (or discarded) has nothing
  // approved to learn. Letting it count as complete would let unreviewed
  // material unlock the next lecture — exactly what the approval gate exists
  // to prevent.
  if (concepts.length === 0) return false;
  return concepts.every((concept) => {
    const progress = learner.progress[concept.id];
    // Only a Tutor retrieval satisfies a taught chunk; Study ratings never do.
    return (
      progress !== undefined &&
      hasTutorAttempt(progress) &&
      !pendingRemediation(progress)
    );
  });
}

/**
 * Derive completed chunks and lectures from concept-level progress.
 *
 * Completion is computed, never asserted by the UI, so a client cannot mark a
 * lecture done without the underlying retrieval actually having happened.
 */
export function reconcile(
  curriculum: Curriculum,
  learner: LearnerState,
): LearnerState {
  const completedChunkIds = new Set<string>();
  const completedLectureIds = new Set<string>();
  const taughtChunkIds = new Set(learner.taughtChunkIds);

  // Weakness does not revoke completion. Newly approved material does: an old
  // completed chunk id must not silently skip an unattempted ACTIVE concept.
  for (const lecture of curriculum.course.lectures) {
    for (const chunk of lecture.chunks) {
      const active = conceptsForChunk(curriculum, chunk);
      const wasComplete = learner.completedChunkIds.includes(chunk.id);
      // "Attempted" means retrieved by the Tutor. Study ratings alone never
      // complete a chunk, a lecture, or unlock the next lecture.
      const allAttempted = active.length > 0 && active.every(
        (c) => hasTutorAttempt(learner.progress[c.id]),
      );
      if (wasComplete && active.some((c) => !hasTutorAttempt(learner.progress[c.id]))) {
        taughtChunkIds.delete(chunk.id);
      }
      if ((wasComplete && allAttempted) || isChunkComplete(curriculum, learner, chunk)) {
        completedChunkIds.add(chunk.id);
      }
    }
    const requiredChunks = lecture.chunks.filter((c) => !excludedChunk(curriculum, c));
    const allChunksDone =
      requiredChunks.length > 0 &&
      requiredChunks.every((c) => completedChunkIds.has(c.id));
    if (allChunksDone) completedLectureIds.add(lecture.id);
  }

  return {
    ...learner,
    taughtChunkIds: [...taughtChunkIds],
    completedChunkIds: [...completedChunkIds],
    completedLectureIds: [...completedLectureIds],
  };
}

/* ------------------------------------------------------------------ */
/* Retrieval item selection                                            */
/* ------------------------------------------------------------------ */

/**
 * Choose which form of a concept to test. Remediation deliberately uses a
 * different form where one exists, so passing it means re-expressing the idea
 * rather than echoing the sentence just read.
 */
export function pickItem(
  concept: Concept,
  context: RetrievalContext,
  progress: ConceptProgress | undefined,
): RetrievalItem {
  assertActive(concept, "retrieval");
  const items = concept.retrievalItems;
  if (items.length === 0) {
    throw new Error(`Concept "${concept.id}" has no retrieval items`);
  }
  const first = items[0]!;
  if (context === "INITIAL") return first;
  if (context === "IMMEDIATE_REMEDIATION") return items[1] ?? first;
  // Rotate by Tutor attempts only, so Study ratings never change which
  // representation the Tutor asks next.
  const attempts = tutorAttemptCount(progress);
  return items[attempts % items.length] ?? first;
}

/* ------------------------------------------------------------------ */
/* Cross-lecture interleaving                                          */
/* ------------------------------------------------------------------ */

/**
 * Pick a concept from an EARLIER lecture to inject into the current one.
 *
 * This is the cross-lecture memory feature: struggling with ATP depletion in
 * Lecture 1 means it resurfaces during Lecture 2. Limited to one injection per
 * chunk so the current lecture is not constantly interrupted.
 */
export function selectInterleavedConcept(
  curriculum: Curriculum,
  learner: LearnerState,
  currentLectureId: string,
  chunkId: string,
  now: Date,
): Concept | null {
  const current = getLecture(curriculum, currentLectureId);
  const alreadyInjected = learner.injectedByChunk[chunkId] ?? [];
  if (alreadyInjected.length > 0) return null;

  const earlierLectureIds = new Set(
    curriculum.course.lectures
      .filter((l) => l.order < current.order)
      .map((l) => l.id),
  );

  const currentConceptIds = conceptsForLecture(curriculum, currentLectureId).map(
    (c) => c.id,
  );

  const candidates = activeOnly(curriculum.concepts)
    .filter((c) => earlierLectureIds.has(c.lectureId))
    .filter((c) => !alreadyInjected.includes(c.id))
    .map((concept) => ({ concept, progress: learner.progress[concept.id] }))
    .filter(
      (e): e is { concept: Concept; progress: ConceptProgress } =>
        e.progress !== undefined &&
        e.progress.totalAttempts > 0 &&
        (e.progress.mastery === "WEAK" || isDue(e.progress, now)),
    )
    .map(({ concept, progress }) => ({
      concept,
      score: scoreConcept(concept, progress, {
        now,
        curriculum,
        currentConceptIds,
      }),
    }))
    .sort((a, b) => b.score - a.score || a.concept.id.localeCompare(b.concept.id));

  return candidates[0]?.concept ?? null;
}

/* ------------------------------------------------------------------ */
/* Session steps                                                       */
/* ------------------------------------------------------------------ */

export type SessionStep =
  | {
      kind: "INTERLEAVE";
      chunk: TeachingChunk;
      concept: Concept;
      item: RetrievalItem;
      context: "INTERLEAVED";
      fromLecture: Lecture;
    }
  | {
      kind: "TEACH";
      chunk: TeachingChunk;
      pages: Page[];
      concepts: Concept[];
    }
  | {
      kind: "RETRIEVE";
      chunk: TeachingChunk;
      concept: Concept;
      item: RetrievalItem;
      context: "INITIAL";
    }
  | {
      kind: "REMEDIATE";
      chunk: TeachingChunk;
      concept: Concept;
      item: RetrievalItem;
      context: "IMMEDIATE_REMEDIATION";
    }
  | {
      kind: "AWAITING_APPROVAL";
      chunk: TeachingChunk;
      /** Candidates on this chunk still waiting for a human decision. */
      draftCount: number;
    }
  | { kind: "LECTURE_COMPLETE"; lecture: Lecture };

/**
 * The learner never chooses what to do next; this does.
 *
 * Pure: it reads state and returns the next step without mutating anything.
 * State only advances through `markChunkTaught` and `recordGradedAttempt`
 * (or its deterministic wrapper `recordAttempt`).
 */
export function getNextStep(
  curriculum: Curriculum,
  learner: LearnerState,
  lectureId: string,
  now: Date,
): SessionStep {
  learner = reconcile(curriculum, learner);
  assertLectureUnlocked(curriculum, learner, lectureId);
  const lecture = getLecture(curriculum, lectureId);

  const sourceChunk = [...lecture.chunks]
    .sort((a, b) => a.order - b.order)
    .find((c) => !learner.completedChunkIds.includes(c.id) && !excludedChunk(curriculum, c));

  if (!sourceChunk) {
    if (lecture.chunks.length > 0 && !learner.completedLectureIds.includes(lecture.id)) {
      return { kind: "AWAITING_APPROVAL", chunk: approvedChunk(curriculum, lecture.chunks[0]!), draftCount: 0 };
    }
    return { kind: "LECTURE_COMPLETE", lecture };
  }
  const chunk = approvedChunk(curriculum, sourceChunk);

  // A wrong answer is re-taught immediately, before anything else happens.
  // This is checked across this lecture AND every earlier lecture, so failing
  // an INTERLEAVED question from an earlier lecture also earns remediation.
  // A later lecture's material never interrupts an earlier one, and a concept
  // the Tutor has never retrieved never triggers it (see pendingRemediation).
  const inTutorScope = new Set(
    curriculum.course.lectures.filter((l) => l.order <= lecture.order).map((l) => l.id),
  );
  const toRemediate = activeOnly(curriculum.concepts).find(
    (c) => inTutorScope.has(c.lectureId) && pendingRemediation(learner.progress[c.id]),
  );
  if (toRemediate) {
    return {
      kind: "REMEDIATE",
      chunk,
      concept: toRemediate,
      item: pickItem(
        toRemediate,
        "IMMEDIATE_REMEDIATION",
        learner.progress[toRemediate.id],
      ),
      context: "IMMEDIATE_REMEDIATION",
    };
  }

  // Nothing in this chunk has been approved yet, so there is nothing to teach.
  const approvedHere = conceptsForChunk(curriculum, chunk);
  if (approvedHere.length === 0) {
    const draftCount = sourceChunk.conceptIds.filter(
      (id) => curriculum.concepts.find((c) => c.id === id)?.status === "DRAFT",
    ).length;
    return { kind: "AWAITING_APPROVAL", chunk, draftCount };
  }

  // Before teaching new material, surface one weak/due concept from earlier.
  if (!learner.taughtChunkIds.includes(chunk.id)) {
    const injected = selectInterleavedConcept(
      curriculum,
      learner,
      lectureId,
      chunk.id,
      now,
    );
    if (injected) {
      const progress = learner.progress[injected.id];
      return {
        kind: "INTERLEAVE",
        chunk,
        concept: injected,
        item: pickItem(injected, "INTERLEAVED", progress),
        context: "INTERLEAVED",
        fromLecture: getLecture(curriculum, injected.lectureId),
      };
    }
    return {
      kind: "TEACH",
      chunk,
      // A generated page IS the candidate sentences, so only the excerpts of
      // ACTIVE concepts may be shown. Authored source pages are part of the
      // authored lecture and are served in full.
      pages: chunk.generated
        ? pagesForChunk(lecture, chunk).flatMap((page) => {
            const excerpts = approvedHere.filter(
              (c) => c.source.pageNumber === page.number,
            );
            return excerpts.length > 0
              ? [
                  {
                    number: page.number,
                    // Neutral label: the stored heading is unreviewed source.
                    title: `Page ${page.number}`,
                    text: excerpts.map((c) => c.source.excerpt).join("\n\n"),
                  },
                ]
              : [];
          })
        : pagesForChunk(lecture, chunk),
      concepts: conceptsForChunk(curriculum, chunk),
    };
  }

  const concepts = conceptsForChunk(curriculum, chunk);

  // Untested by the TUTOR: a concept rated only in Study still gets its
  // normal Tutor retrieval.
  const untested = concepts.find((c) => !hasTutorAttempt(learner.progress[c.id]));
  if (untested) {
    return {
      kind: "RETRIEVE",
      chunk,
      concept: untested,
      item: pickItem(untested, "INITIAL", learner.progress[untested.id]),
      context: "INITIAL",
    };
  }

  return { kind: "LECTURE_COMPLETE", lecture };
}

/* ------------------------------------------------------------------ */
/* State transitions                                                   */
/* ------------------------------------------------------------------ */

export function markChunkTaught(
  curriculum: Curriculum,
  learner: LearnerState,
  chunkId: string,
): LearnerState {
  learner = reconcile(curriculum, learner);
  if (learner.taughtChunkIds.includes(chunkId)) return learner;
  return reconcile(curriculum, {
    ...learner,
    taughtChunkIds: [...learner.taughtChunkIds, chunkId],
  });
}

export interface AttemptInput {
  conceptId: string;
  itemId: string;
  answer: string;
  context: RetrievalContext;
  /** Set for interleaved injections so a chunk only interrupts once. */
  chunkId?: string;
  now: Date;
}

/**
 * Everything the engine needs to fold an ALREADY-GRADED attempt into state.
 * The answer text is deliberately absent: by this point the assessment has
 * been made, and the engine must not re-grade or second-guess it.
 */
export type GradedAttemptInput = Omit<AttemptInput, "answer">;

export interface AttemptResult {
  learner: LearnerState;
  grade: GradeResult;
  progress: ConceptProgress;
  concept: Concept;
  item: RetrievalItem;
}

/**
 * Resolve the concept and item for an attempt, enforcing the approval gate
 * and that the item really is a representation of that concept.
 */
export function resolveAttemptTarget(
  curriculum: Curriculum,
  conceptId: string,
  itemId: string,
): { concept: Concept; item: RetrievalItem } {
  const concept = getConcept(curriculum, conceptId);

  // The approval gate, enforced in the domain layer rather than the UI.
  assertActive(concept, "retrieval");

  const item = getItem(concept, itemId);
  if (item.conceptId !== concept.id) {
    throw new ItemConceptMismatchError(concept.id, item.id);
  }
  return { concept, item };
}

/**
 * The exact content a grade was computed against: the concept's identity,
 * wording, status and provenance, and the retrieval item's prompt, rubric and
 * explanation. Deterministic — an array, so field order is fixed — and
 * compared as a whole string, so any change at all is detected.
 */
export function gradingTargetFingerprint(concept: Concept, item: RetrievalItem): string {
  return JSON.stringify([
    concept.id,
    concept.courseId,
    concept.lectureId,
    concept.title,
    concept.summary,
    concept.status,
    concept.source.courseId,
    concept.source.lectureId,
    concept.source.documentId,
    concept.source.pageNumber,
    concept.source.excerpt,
    item.id,
    item.conceptId,
    item.kind,
    item.prompt,
    item.requiredKeywords,
    item.acceptableAnswers,
    item.explanation,
  ]);
}

/**
 * What an asynchronous attempt was made against, captured when the learner
 * submits. Checked again when the grade arrives (optimistic concurrency): if
 * the question or this concept's progress has moved on, the grade is stale.
 */
export interface AttemptPrecondition {
  conceptId: string;
  itemId: string;
  /** This concept's progress version at submission. */
  totalAttempts: number;
  lastAttemptAt: string | null;
  lastReview: string | null;
  /** `gradingTargetFingerprint()` at submission. */
  target: string;
}

/** Capture the precondition for an attempt. Gated: DRAFT/DISCARDED throw. */
export function captureAttemptPrecondition(
  curriculum: Curriculum,
  learner: LearnerState,
  conceptId: string,
  itemId: string,
): AttemptPrecondition {
  const { concept, item } = resolveAttemptTarget(curriculum, conceptId, itemId);
  const progress = learner.progress[concept.id];
  return {
    conceptId: concept.id,
    itemId: item.id,
    totalAttempts: progress?.totalAttempts ?? 0,
    lastAttemptAt: progress?.lastAttemptAt ?? null,
    lastReview: progress?.schedule.last_review ?? null,
    target: gradingTargetFingerprint(concept, item),
  };
}

function assertPreconditionHolds(
  concept: Concept,
  item: RetrievalItem,
  learner: LearnerState,
  input: GradedAttemptInput,
  expected: AttemptPrecondition,
): void {
  if (expected.conceptId !== concept.id || expected.itemId !== item.id) {
    throw new StaleAttemptError("TARGET_MISMATCH");
  }
  // Graded against a different question, rubric or source than exists now.
  if (gradingTargetFingerprint(concept, item) !== expected.target) {
    throw new StaleAttemptError("TARGET_CHANGED");
  }
  // This concept was attempted (here or in another tab) since submission.
  const progress = learner.progress[concept.id];
  if (
    (progress?.totalAttempts ?? 0) !== expected.totalAttempts ||
    (progress?.lastAttemptAt ?? null) !== expected.lastAttemptAt ||
    (progress?.schedule.last_review ?? null) !== expected.lastReview
  ) {
    throw new StaleAttemptError("PROGRESS_CHANGED");
  }
  // FSRS must never be run with an attempt time older than the card's last
  // review or the concept's last attempt.
  const at = input.now.getTime();
  for (const stamp of [progress?.schedule.last_review, progress?.lastAttemptAt]) {
    if (stamp && new Date(stamp).getTime() > at) {
      throw new StaleAttemptError("OUT_OF_ORDER");
    }
  }
}

/**
 * Fold one already-graded attempt into learner state: mastery, FSRS schedule,
 * interleaving bookkeeping and derived completion, in one pure step.
 *
 * GRADING DECISION != STATE MUTATION. Whoever produced `grade` (the
 * deterministic grader today, a model later) decided only the assessment. What
 * that assessment does to mastery and scheduling is decided here, by the same
 * deterministic rules regardless of who graded. This function never calls a
 * provider or the network, and it validates the gate, the grade and — when a
 * `precondition` is given — that the question and this concept's progress are
 * still exactly what the grade was made against, all before touching
 * anything. On any failure it throws and the caller's state is unchanged.
 *
 * Asynchronous callers MUST pass the precondition captured at submission.
 *
 * PARTIAL is not yet given credit: until its mastery policy exists, only
 * outcome "CORRECT" counts as a success.
 */
export function recordGradedAttempt(
  curriculum: Curriculum,
  learner: LearnerState,
  input: GradedAttemptInput,
  grade: GradeResult,
  precondition?: AttemptPrecondition,
): AttemptResult {
  const { concept, item } = resolveAttemptTarget(
    curriculum,
    input.conceptId,
    input.itemId,
  );

  if (precondition) {
    assertPreconditionHolds(concept, item, learner, input, precondition);
  }

  if (!isValidGradeResult(grade)) {
    throw new InvalidGradeError("grade failed structural validation");
  }
  const accepted = sanitizeGradeResult(grade);
  const correct = accepted.outcome === "CORRECT";

  const before = ensureProgress(learner, concept.id, input.now);
  const afterMastery = applyRetrievalToMastery(before, {
    correct,
    context: input.context,
    at: input.now.toISOString(),
  });
  const schedule = scheduleAfterAttempt(
    concept,
    before,
    correct,
    input.context,
    input.now,
  );
  const progress: ConceptProgress = { ...afterMastery, schedule };

  const injectedByChunk = { ...learner.injectedByChunk };
  if (input.context === "INTERLEAVED" && input.chunkId) {
    const existing = injectedByChunk[input.chunkId] ?? [];
    if (!existing.includes(concept.id)) {
      injectedByChunk[input.chunkId] = [...existing, concept.id];
    }
  }

  const next = reconcile(curriculum, {
    ...learner,
    progress: { ...learner.progress, [concept.id]: progress },
    injectedByChunk,
  });

  return { learner: next, grade: accepted, progress, concept, item };
}

/**
 * Deterministic compatibility wrapper: grade locally with `gradeAnswer`, then
 * fold the result in through `recordGradedAttempt`.
 *
 * The app no longer uses this on the learner's path — answers are graded by
 * the server — but it is the oracle the server-boundary flow is tested
 * against, and it keeps internal callers and regression tests working.
 */
export function recordAttempt(
  curriculum: Curriculum,
  learner: LearnerState,
  input: AttemptInput,
): AttemptResult {
  // Gate before grading: a non-ACTIVE concept is never assessed at all.
  const { item } = resolveAttemptTarget(curriculum, input.conceptId, input.itemId);
  const grade = gradeAnswer(item, input.answer);
  return recordGradedAttempt(
    curriculum,
    learner,
    {
      conceptId: input.conceptId,
      itemId: input.itemId,
      context: input.context,
      chunkId: input.chunkId,
      now: input.now,
    },
    grade,
  );
}

/* ------------------------------------------------------------------ */
/* Read models for the UI                                              */
/* ------------------------------------------------------------------ */

export interface LectureSummary {
  lecture: Lecture;
  unlocked: boolean;
  complete: boolean;
  totalConcepts: number;
  attemptedConcepts: number;
  weakConcepts: number;
}

export function summarizeLectures(
  curriculum: Curriculum,
  learner: LearnerState,
): LectureSummary[] {
  learner = reconcile(curriculum, learner);
  return [...curriculum.course.lectures]
    .sort((a, b) => a.order - b.order)
    .map((lecture) => {
      const concepts = conceptsForLecture(curriculum, lecture.id);
      const attempted = concepts.filter(
        (c) => (learner.progress[c.id]?.totalAttempts ?? 0) > 0,
      );
      const weak = concepts.filter(
        (c) => learner.progress[c.id]?.mastery === "WEAK",
      );
      return {
        lecture,
        unlocked: isLectureUnlocked(curriculum, learner, lecture.id),
        complete: learner.completedLectureIds.includes(lecture.id),
        totalConcepts: concepts.length,
        attemptedConcepts: attempted.length,
        weakConcepts: weak.length,
      };
    });
}

/** The lecture the learner should continue with. */
export function nextLecture(
  curriculum: Curriculum,
  learner: LearnerState,
): Lecture | null {
  const summaries = summarizeLectures(curriculum, learner);
  return (
    summaries.find((s) => s.unlocked && !s.complete)?.lecture ??
    summaries.find((s) => s.unlocked)?.lecture ??
    null
  );
}

export { isActive };
