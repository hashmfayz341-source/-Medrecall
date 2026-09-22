import type {
  Concept,
  ConceptStatus,
  Curriculum,
  Lecture,
  SourceDocument,
  TeachingChunk,
} from "./types";

/**
 * Shared curriculum state.
 *
 * Concept status, human edits and ingested material are curriculum-level:
 * approving a concept changes the course for everyone studying it, while
 * mastery is personal. They are stored separately from learner state so a
 * future release can host curriculum on a server without touching per-learner
 * records.
 */

export const CURRICULUM_OVERRIDES_VERSION = 2;

/** A human edit to a candidate concept. Never changes status. */
export interface ConceptEdit {
  title?: string;
  summary?: string;
}

/** One ingested PDF, with the teaching chunks derived from its pages. */
export interface IngestedDocument {
  lectureId: string;
  document: SourceDocument;
  chunks: TeachingChunk[];
  ingestedAt: string;
}

export interface CurriculumOverrides {
  version: number;
  /** Approval decisions, keyed by concept id. */
  statusById: Record<string, ConceptStatus>;
  /** Title/summary edits, keyed by concept id. */
  edits: Record<string, ConceptEdit>;
  /** Lectures created by the user, beyond the authored course. */
  lectures: Lecture[];
  /** Uploaded documents and the chunks built from them. */
  ingested: IngestedDocument[];
  /** Candidate concepts produced by ingestion. */
  concepts: Concept[];
}

export function createOverrides(): CurriculumOverrides {
  return {
    version: CURRICULUM_OVERRIDES_VERSION,
    statusById: {},
    edits: {},
    lectures: [],
    ingested: [],
    concepts: [],
  };
}

/**
 * Upgrade stored state to the current shape.
 *
 * Milestone 1 stored approval decisions only. Those are preserved: a concept
 * the user already approved must not silently revert to DRAFT.
 */
export function migrateOverrides(stored: unknown): CurriculumOverrides | null {
  if (typeof stored !== "object" || stored === null) return null;
  const value = stored as Partial<CurriculumOverrides>;
  if (typeof value.version !== "number") return null;
  if (typeof value.statusById !== "object" || value.statusById === null) return null;
  if (value.version > CURRICULUM_OVERRIDES_VERSION) return null;

  return {
    version: CURRICULUM_OVERRIDES_VERSION,
    statusById: value.statusById,
    edits: value.edits ?? {},
    lectures: value.lectures ?? [],
    ingested: value.ingested ?? [],
    concepts: value.concepts ?? [],
  };
}

function applyEdit(concept: Concept, edit: ConceptEdit | undefined): Concept {
  if (!edit) return concept;
  const title = edit.title?.trim();
  const summary = edit.summary?.trim();
  if (!title && !summary) return concept;
  return {
    ...concept,
    title: title && title.length > 0 ? title : concept.title,
    summary: summary && summary.length > 0 ? summary : concept.summary,
  };
}

/**
 * Compose the live curriculum: authored content, plus ingested material, plus
 * human edits and approval decisions.
 *
 * The base curriculum is never mutated.
 */
export function applyOverrides(
  curriculum: Curriculum,
  overrides: CurriculumOverrides | null,
): Curriculum {
  if (!overrides) return curriculum;

  const lectures: Lecture[] = [
    ...curriculum.course.lectures,
    ...overrides.lectures,
  ].map((lecture) => ({ ...lecture, documents: [...lecture.documents], chunks: [...lecture.chunks] }));

  const byId = new Map(lectures.map((l) => [l.id, l]));
  for (const ingested of overrides.ingested) {
    const lecture = byId.get(ingested.lectureId);
    if (!lecture) continue;
    if (!lecture.documents.some((d) => d.id === ingested.document.id)) {
      lecture.documents.push(ingested.document);
    }
    for (const chunk of ingested.chunks) {
      if (!lecture.chunks.some((c) => c.id === chunk.id)) lecture.chunks.push(chunk);
    }
  }

  const allConcepts = [...curriculum.concepts, ...overrides.concepts].map(
    (concept) => {
      const edited = applyEdit(concept, overrides.edits[concept.id]);
      const status = overrides.statusById[concept.id];
      return status ? { ...edited, status } : edited;
    },
  );

  return {
    course: { ...curriculum.course, lectures: lectures.sort((a, b) => a.order - b.order) },
    concepts: allConcepts,
  };
}

export function setConceptStatus(
  overrides: CurriculumOverrides,
  conceptId: string,
  status: ConceptStatus,
): CurriculumOverrides {
  return {
    ...overrides,
    statusById: { ...overrides.statusById, [conceptId]: status },
  };
}

/** Approve several candidates at once. */
export function setConceptStatuses(
  overrides: CurriculumOverrides,
  conceptIds: readonly string[],
  status: ConceptStatus,
): CurriculumOverrides {
  const statusById = { ...overrides.statusById };
  for (const id of conceptIds) statusById[id] = status;
  return { ...overrides, statusById };
}

/**
 * Record a human edit. Deliberately does NOT touch status: editing a draft
 * leaves it a draft, and approval stays a separate, explicit decision.
 */
export function editConcept(
  overrides: CurriculumOverrides,
  conceptId: string,
  edit: ConceptEdit,
): CurriculumOverrides {
  const existing = overrides.edits[conceptId] ?? {};
  return {
    ...overrides,
    edits: { ...overrides.edits, [conceptId]: { ...existing, ...edit } },
  };
}

export function addLecture(
  overrides: CurriculumOverrides,
  lecture: Lecture,
): CurriculumOverrides {
  return { ...overrides, lectures: [...overrides.lectures, lecture] };
}

/** Store an ingested document, its chunks and its candidate concepts. */
export function addIngestedDocument(
  overrides: CurriculumOverrides,
  ingested: IngestedDocument,
  concepts: readonly Concept[],
): CurriculumOverrides {
  const withoutOld = overrides.ingested.filter(
    (i) => i.document.id !== ingested.document.id,
  );
  const keptConcepts = overrides.concepts.filter(
    (c) => c.source.documentId !== ingested.document.id,
  );
  return {
    ...overrides,
    ingested: [...withoutOld, ingested],
    concepts: [...keptConcepts, ...concepts],
  };
}

export function draftConcepts(curriculum: Curriculum): Concept[] {
  return curriculum.concepts.filter((c) => c.status === "DRAFT");
}

/** Next free lecture order in a course. */
export function nextLectureOrder(curriculum: Curriculum): number {
  return (
    curriculum.course.lectures.reduce((max, l) => Math.max(max, l.order), 0) + 1
  );
}

/** Highest chunk order already used in a lecture. */
export function chunkOrderOffset(curriculum: Curriculum, lectureId: string): number {
  const lecture = curriculum.course.lectures.find((l) => l.id === lectureId);
  if (!lecture) return 0;
  return lecture.chunks.reduce((max, c) => Math.max(max, c.order), 0);
}
