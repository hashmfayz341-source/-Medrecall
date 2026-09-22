import type {
  Concept,
  ConceptStatus,
  Curriculum,
  Lecture,
  SourceDocument,
  TeachingChunk,
} from "./types";
import { buildRetrievalItems } from "./retrieval";

/**
 * Shared curriculum state.
 *
 * Concept status, human edits and ingested material are curriculum-level:
 * approving a concept changes the course for everyone studying it, while
 * mastery is personal. They are stored separately from learner state so a
 * future release can host curriculum on a server without touching per-learner
 * records.
 */

export const CURRICULUM_OVERRIDES_VERSION = 3;

/** Legacy ingestion hashed a buffer after pdfjs had detached it. */
export function hasLegacyDocumentIdentity(documentId: string): boolean {
  return /^doc-.*-[a-f0-9]{8}$/.test(documentId);
}

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

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string");
const status = (value: unknown) => value === "DRAFT" || value === "ACTIVE" || value === "DISCARDED";
const textFields = (value: Record<string, unknown>, fields: string[]) => fields.every((key) => typeof value[key] === "string");
function documentShape(value: unknown): boolean {
  return record(value) && textFields(value, ["id", "lectureId", "title"]) && Array.isArray(value.pages) && value.pages.every((p) =>
    record(p) && Number.isInteger(p.number) && Number(p.number) > 0 && textFields(p, ["title", "text"]));
}
function chunkShape(value: unknown): boolean {
  return record(value) && textFields(value, ["id", "lectureId", "documentId", "title", "explanation"]) && Number.isFinite(value.order) &&
    strings(value.conceptIds) && Array.isArray(value.pageNumbers) && value.pageNumbers.every((n) => Number.isInteger(n) && n > 0);
}
function lectureShape(value: unknown): boolean {
  return record(value) && textFields(value, ["id", "courseId", "title"]) && Number.isFinite(value.order) &&
    Array.isArray(value.documents) && value.documents.every(documentShape) && Array.isArray(value.chunks) && value.chunks.every(chunkShape);
}
function conceptShape(value: unknown): boolean {
  if (!record(value) || !textFields(value, ["id", "courseId", "lectureId", "title", "summary"]) || !status(value.status) || !strings(value.prerequisiteIds)) return false;
  if (value.importance !== "CORE" && value.importance !== "SUPPORTING") return false;
  const source = value.source;
  if (!record(source) || !textFields(source, ["courseId", "lectureId", "documentId", "excerpt"]) || !Number.isInteger(source.pageNumber) || Number(source.pageNumber) < 1) return false;
  return Array.isArray(value.retrievalItems) && value.retrievalItems.length > 0 && value.retrievalItems.every((item) =>
    record(item) && textFields(item, ["id", "conceptId", "prompt", "explanation"]) &&
    ["BASIC", "CLOZE", "MECHANISM", "FREE_RECALL", "CLINICAL", "IMAGE"].includes(String(item.kind)) &&
    strings(item.acceptableAnswers) && Array.isArray(item.requiredKeywords) && item.requiredKeywords.every(strings));
}

/**
 * Upgrade stored state to the current shape.
 *
 * Milestone 1 stored approval decisions only. Those are preserved: a concept
 * the user already approved must not silently revert to DRAFT.
 */
export function migrateOverrides(stored: unknown): CurriculumOverrides | null {
  if (!record(stored)) return null;
  const value = stored as Partial<CurriculumOverrides>;
  if (value.version !== 1 && value.version !== 2 && value.version !== CURRICULUM_OVERRIDES_VERSION) return null;
  if (!record(value.statusById) || !Object.values(value.statusById).every(status)) return null;
  if (value.edits !== undefined && (!record(value.edits) || !Object.values(value.edits).every((edit) => record(edit) &&
    (edit.title === undefined || typeof edit.title === "string") && (edit.summary === undefined || typeof edit.summary === "string")))) return null;
  if (value.lectures !== undefined && (!Array.isArray(value.lectures) || !value.lectures.every(lectureShape))) return null;
  if (value.concepts !== undefined && (!Array.isArray(value.concepts) || !value.concepts.every(conceptShape))) return null;
  if (value.ingested !== undefined && (!Array.isArray(value.ingested) || !value.ingested.every((entry) => record(entry) &&
    textFields(entry, ["lectureId", "ingestedAt"]) && documentShape(entry.document) && Array.isArray(entry.chunks) && entry.chunks.every(chunkShape)))) return null;

  const migrated: CurriculumOverrides = {
    version: CURRICULUM_OVERRIDES_VERSION,
    statusById: value.statusById,
    edits: value.edits ?? {},
    lectures: value.lectures ?? [],
    ingested: value.ingested ?? [],
    concepts: value.concepts ?? [],
  };
  // Old same-name uploads could replace text while retaining an unrelated
  // approval. The original bytes are gone; do not invent a safe identity or
  // silently trust that approval. Authored/M1 and new identities are retained.
  const legacyDocuments = new Set(migrated.ingested
    .filter((entry) => hasLegacyDocumentIdentity(entry.document.id))
    .map((entry) => entry.document.id));
  migrated.statusById = { ...migrated.statusById };
  for (const concept of migrated.concepts) {
    if (value.version < 3 && legacyDocuments.has(concept.source.documentId) &&
      (migrated.statusById[concept.id] ?? concept.status) === "ACTIVE") {
      migrated.statusById[concept.id] = "DRAFT";
    }
  }
  return migrated;
}

function applyEdit(concept: Concept, edit: ConceptEdit | undefined): Concept {
  if (!edit) return concept;
  const title = edit.title?.trim();
  const summary = edit.summary?.trim();
  if (!title && !summary) return concept;
  const nextTitle = title || concept.title;
  const nextSummary = summary || concept.summary;
  return {
    ...concept,
    title: nextTitle,
    summary: nextSummary,
    // A reviewed correction must reach prompts, accepted answers and feedback,
    // while the original source excerpt remains immutable.
    retrievalItems: buildRetrievalItems(
      concept.id, nextTitle, nextTitle,
      nextSummary.replace(nextTitle, "").trim(), nextSummary,
      "the source", concept.source.pageNumber,
    ),
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
      // A chunk reached here from an ingested document, so it IS generated —
      // whatever the stored flag says. Stores written before the flag existed
      // carry pre-review prose, and trusting their silence would serve it.
      if (!lecture.chunks.some((c) => c.id === chunk.id)) {
        lecture.chunks.push({ ...chunk, generated: true });
      }
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
  // Re-uploading identical bytes to this lecture must not move its chunks to
  // the end, reset reviewed wording, or disturb progress.
  if (overrides.ingested.some((i) => i.document.id === ingested.document.id && i.lectureId === ingested.lectureId)) {
    return overrides;
  }
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
