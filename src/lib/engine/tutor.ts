import { activeOnly, assertActive, isActive } from "@/lib/domain/gate";
import { LectureLockedError } from "@/lib/domain/errors";
import { applyRetrievalToMastery, createProgress } from "@/lib/domain/mastery";
import { gradeAnswer, type GradeResult } from "@/lib/grading";
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
  return {
    ...chunk,
    conceptIds: concepts.map((c) => c.id),
    explanation: [
      chunk.explanation,
      concepts.map((c) => `• ${c.summary}`).join("\n"),
    ]
      .filter((part) => part.length > 0)
      .join("\n\n"),
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
 * A concept is awaiting immediate remediation when it was just answered wrong
 * and the learner has not yet worked back through the explanation.
 */
export function pendingRemediation(progress: ConceptProgress | undefined): boolean {
  if (!progress) return false;
  return (
    progress.totalAttempts > 0 &&
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
    return (
      progress !== undefined &&
      progress.totalAttempts > 0 &&
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
      const allAttempted = active.length > 0 && active.every(
        (c) => (learner.progress[c.id]?.totalAttempts ?? 0) > 0,
      );
      if (wasComplete && active.some((c) => !learner.progress[c.id]?.totalAttempts)) {
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
  const attempts = progress?.totalAttempts ?? 0;
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
 * State only advances through `markChunkTaught` and `recordAttempt`.
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
  // This is checked across the whole curriculum, not just the current chunk,
  // so failing an INTERLEAVED question from an earlier lecture also earns
  // remediation rather than being silently dropped.
  const toRemediate = activeOnly(curriculum.concepts).find((c) =>
    pendingRemediation(learner.progress[c.id]),
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
                    title: page.title,
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

  const untested = concepts.find(
    (c) => (learner.progress[c.id]?.totalAttempts ?? 0) === 0,
  );
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

export interface AttemptResult {
  learner: LearnerState;
  grade: GradeResult;
  progress: ConceptProgress;
  concept: Concept;
  item: RetrievalItem;
}

/**
 * Grade one answer and fold the result into learner state: mastery, FSRS
 * schedule, interleaving bookkeeping and derived completion, in one step.
 */
export function recordAttempt(
  curriculum: Curriculum,
  learner: LearnerState,
  input: AttemptInput,
): AttemptResult {
  const concept = getConcept(curriculum, input.conceptId);

  // The approval gate, enforced in the domain layer rather than the UI.
  assertActive(concept, "retrieval");

  const item = getItem(concept, input.itemId);
  const grade = gradeAnswer(item, input.answer);

  const before = ensureProgress(learner, concept.id, input.now);
  const afterMastery = applyRetrievalToMastery(before, {
    correct: grade.correct,
    context: input.context,
    at: input.now.toISOString(),
  });
  const schedule = scheduleAfterAttempt(
    concept,
    before,
    grade.correct,
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

  return { learner: next, grade, progress, concept, item };
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
