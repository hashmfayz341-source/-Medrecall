import type {
  Concept,
  ConceptImportance,
  Curriculum,
  Lecture,
  LearnerState,
  RetrievalItem,
  RetrievalKind,
  SourceDocument,
} from "@/lib/domain/types";
import {
  buildStudyQueueFor,
  cardFlagsFor,
  isBuried,
  isSuspended,
  studyCardsForCourse,
  studyCardsForLecture,
  type StudyCounts,
  type StudyLimits,
  type StudyQueueKind,
} from "./study";
import { queueForSchedule } from "./scheduler";

/**
 * Decks and the card browser — DERIVED views, never a second source of truth.
 *
 * MedRecall is Concept-first: a deck is simply a Lecture seen as its ACTIVE
 * concepts' cards, and a card is a RetrievalItem of an ACTIVE Concept. Nothing
 * here stores deck membership; it is read from Course → Lecture → Concept
 * every time, so approving, editing or discarding a concept changes the deck
 * at once and DRAFT/DISCARDED material can never be in one.
 */

export interface LectureDeck {
  lecture: Lecture;
  /** Studyable cards (ACTIVE concepts only), suspended and buried included. */
  total: number;
  counts: StudyCounts;
}

export interface CourseDeck {
  total: number;
  counts: StudyCounts;
  lectures: LectureDeck[];
}

/** One deck per lecture, in course order, with real Card-FSRS counts. */
export function lectureDecks(
  curriculum: Curriculum,
  learner: LearnerState,
  now: Date,
  limits?: StudyLimits,
): LectureDeck[] {
  return [...curriculum.course.lectures]
    .sort((a, b) => a.order - b.order)
    .map((lecture) => {
      const cards = studyCardsForLecture(curriculum, lecture.id);
      const queue = buildStudyQueueFor(curriculum, learner, cards, now, { limits });
      return { lecture, total: cards.length, counts: queue.counts };
    });
}

/**
 * The whole course as one deck. Learning, suspended and buried counts are the
 * sums of the lecture decks; new and review are the course-wide queue's, so
 * the daily limits (which are per learner, not per deck) apply once.
 */
export function courseDeck(
  curriculum: Curriculum,
  learner: LearnerState,
  now: Date,
  limits?: StudyLimits,
): CourseDeck {
  const lectures = lectureDecks(curriculum, learner, now, limits);
  const course = buildStudyQueueFor(curriculum, learner, studyCardsForCourse(curriculum), now, { limits });
  return { total: lectures.reduce((n, d) => n + d.total, 0), counts: course.counts, lectures };
}

/* ------------------------------------------------------------------ */
/* Card browser                                                        */
/* ------------------------------------------------------------------ */

export type CardStudyStatus = StudyQueueKind | "SUSPENDED" | "BURIED";

export interface BrowserRow {
  concept: Concept;
  item: RetrievalItem;
  lecture: Lecture;
  document: SourceDocument | null;
  /** FSRS queue of the card, before suspension/burying is considered. */
  queue: StudyQueueKind;
  /** What the learner sees: the queue, or SUSPENDED / BURIED. */
  status: CardStudyStatus;
  reviews: number;
  due: Date | null;
  /** Due for review now (Learning or Review card whose due time has passed). */
  dueNow: boolean;
  buriedUntil: Date | null;
}

export interface BrowserFilter {
  lectureId?: string;
  kind?: RetrievalKind;
  importance?: ConceptImportance;
  status?: CardStudyStatus | "DUE";
  /** Case-insensitive substring of the prompt, explanation or concept title. */
  text?: string;
}

/**
 * Every studyable card, in course → lecture → teaching order, with its Study
 * status and provenance, optionally filtered. Filters use existing metadata
 * only (lecture, item kind, concept importance, FSRS status) — there is no
 * separate tagging system.
 */
export function browseCards(
  curriculum: Curriculum,
  learner: LearnerState,
  now: Date,
  filter: BrowserFilter = {},
): BrowserRow[] {
  const documents = new Map<string, SourceDocument>();
  for (const lecture of curriculum.course.lectures) {
    for (const document of lecture.documents) documents.set(document.id, document);
  }
  const text = filter.text?.trim().toLowerCase();
  const rows: BrowserRow[] = [];

  for (const lecture of [...curriculum.course.lectures].sort((a, b) => a.order - b.order)) {
    if (filter.lectureId && lecture.id !== filter.lectureId) continue;
    for (const { concept, item } of studyCardsForLecture(curriculum, lecture.id)) {
      if (filter.kind && item.kind !== filter.kind) continue;
      if (filter.importance && concept.importance !== filter.importance) continue;
      if (
        text &&
        ![item.prompt, item.explanation, concept.title].some((s) => s.toLowerCase().includes(text))
      ) {
        continue;
      }
      const progress = learner.cards?.[item.id];
      const card = progress && progress.conceptId === concept.id ? progress : null;
      const queue = card ? queueForSchedule(card.schedule) : "NEW";
      const flags = cardFlagsFor(learner, item.id);
      const suspended = isSuspended(flags);
      const buried = !suspended && isBuried(flags, now);
      const due = card ? new Date(card.schedule.due) : null;
      const dueNow = !suspended && !buried && queue !== "NEW" && due !== null && due.getTime() <= now.getTime();
      const status: CardStudyStatus = suspended ? "SUSPENDED" : buried ? "BURIED" : queue;
      if (filter.status === "DUE" ? !dueNow : filter.status && status !== filter.status) continue;
      rows.push({
        concept,
        item,
        lecture,
        document: documents.get(concept.source.documentId) ?? null,
        queue,
        status,
        reviews: card?.reviews ?? 0,
        due,
        dueNow,
        buriedUntil: buried && flags?.buriedUntil ? new Date(flags.buriedUntil) : null,
      });
    }
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* Custom study                                                        */
/* ------------------------------------------------------------------ */

/**
 * What a Study session is over. Every kind uses the same cards, the same FSRS
 * scheduling and the same rating path; a selection only decides WHICH cards
 * are in the queue (and, for "due", that new cards are left out).
 */
export type StudySelection =
  | { kind: "lecture"; lectureId: string }
  | { kind: "due" }
  | { kind: "filter"; filter: BrowserFilter };

export interface ResolvedSelection {
  title: string;
  cards: { concept: Concept; item: RetrievalItem }[];
  /** Only due Learning/Review cards; never new ones. */
  dueOnly: boolean;
  /** Null when the selection names a lecture that does not exist. */
  lecture: Lecture | null;
}

export function resolveStudySelection(
  curriculum: Curriculum,
  learner: LearnerState,
  now: Date,
  selection: StudySelection,
): ResolvedSelection {
  if (selection.kind === "lecture") {
    const lecture = curriculum.course.lectures.find((l) => l.id === selection.lectureId) ?? null;
    return {
      title: lecture?.title ?? "Study",
      cards: lecture ? studyCardsForLecture(curriculum, lecture.id) : [],
      dueOnly: false,
      lecture,
    };
  }
  if (selection.kind === "due") {
    return { title: "All due cards", cards: studyCardsForCourse(curriculum), dueOnly: true, lecture: null };
  }
  const rows = browseCards(curriculum, learner, now, selection.filter);
  return {
    title: "Custom study",
    cards: rows.map((r) => ({ concept: r.concept, item: r.item })),
    dueOnly: selection.filter.status === "DUE",
    lecture: null,
  };
}

/** `/study/custom?…` ↔ selection. Unknown or empty params mean the whole course. */
export function selectionFromParams(params: URLSearchParams): StudySelection {
  if (params.get("scope") === "due") return { kind: "due" };
  const filter: BrowserFilter = {};
  const lecture = params.get("lecture");
  if (lecture) filter.lectureId = lecture;
  const kind = params.get("kind");
  if (kind) filter.kind = kind as RetrievalKind;
  const importance = params.get("importance");
  if (importance === "CORE" || importance === "SUPPORTING") filter.importance = importance;
  const status = params.get("status");
  if (status) filter.status = status as BrowserFilter["status"];
  const text = params.get("text");
  if (text) filter.text = text;
  return { kind: "filter", filter };
}

export function selectionToParams(selection: StudySelection, ignoreLimits: boolean): URLSearchParams {
  const params = new URLSearchParams();
  if (selection.kind === "due") params.set("scope", "due");
  else if (selection.kind === "lecture") params.set("lecture", selection.lectureId);
  else {
    const f = selection.filter;
    if (f.lectureId) params.set("lecture", f.lectureId);
    if (f.kind) params.set("kind", f.kind);
    if (f.importance) params.set("importance", f.importance);
    if (f.status) params.set("status", f.status);
    if (f.text) params.set("text", f.text);
  }
  if (ignoreLimits) params.set("ignoreLimits", "1");
  return params;
}
