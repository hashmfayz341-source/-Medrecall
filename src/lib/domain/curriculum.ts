import type {
  SourceRef,
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

export const CURRICULUM_OVERRIDES_VERSION = 4;

/** Legacy ingestion hashed a buffer after pdfjs had detached it. */
export function hasLegacyDocumentIdentity(documentId: string): boolean {
  return /^doc-.*-[a-f0-9]{8}$/.test(documentId);
}

/** A human edit to a candidate concept. Never changes status. */
export interface ConceptEdit {
  title?: string;
  summary?: string;
}

/**
 * A human edit to one Study card (a RetrievalItem), keyed by the item's id.
 * Only the wording the learner sees is editable; the concept, its source
 * excerpt, status and grading rubric are not. The id is unchanged, so the
 * card's FSRS history is kept; the content fingerprint changes, so a rating
 * revealed against the old wording is refused as stale.
 */
export interface CardEdit {
  prompt?: string;
  explanation?: string;
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
  /** Card wording edits, keyed by retrieval item id. */
  cardEdits: Record<string, CardEdit>;
  /**
   * Reviewer decisions that a concept duplicates another: duplicate id →
   * canonical id. The duplicate is DISCARDED; its teaching pages and its
   * provenance go to the canonical (see `applyOverrides`).
   */
  merges: Record<string, string>;
  /** Duplicate suggestions a reviewer rejected: concept id → canonical id. */
  keptApart: Record<string, string>;
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
    cardEdits: {},
    merges: {},
    keptApart: {},
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
function sourceShape(value: unknown): value is SourceRef {
  return record(value) && textFields(value, ["courseId", "lectureId", "documentId", "excerpt"]) && Number.isInteger(value.pageNumber) && Number(value.pageNumber) >= 1;
}
function conceptShape(value: unknown): boolean {
  if (!record(value) || !textFields(value, ["id", "courseId", "lectureId", "title", "summary"]) || !status(value.status) || !strings(value.prerequisiteIds)) return false;
  if (value.importance !== "CORE" && value.importance !== "SUPPORTING") return false;
  if (!sourceShape(value.source)) return false;
  return Array.isArray(value.retrievalItems) && value.retrievalItems.length > 0 && value.retrievalItems.every((item) =>
    record(item) && textFields(item, ["id", "conceptId", "prompt", "explanation"]) &&
    ["BASIC", "CLOZE", "MECHANISM", "FREE_RECALL", "CLINICAL", "IMAGE"].includes(String(item.kind)) &&
    strings(item.acceptableAnswers) && Array.isArray(item.requiredKeywords) && item.requiredKeywords.every(strings));
}

/**
 * Per-entry validation of a stored id map (`merges`, `keptApart`). A
 * malformed entry is dropped on its own and named in `dropped`; the rest of
 * the map, and the rest of the store, load. A container of the wrong type
 * is treated as empty for the same reason: one bad field must never make
 * every uploaded document disappear.
 */
function sanitizeIdMap(value: unknown, label: string, dropped: string[]): Record<string, string> {
  if (value === undefined) return {};
  if (!record(value)) {
    dropped.push(label);
    return {};
  }
  const kept: Record<string, string> = {};
  for (const [key, id] of Object.entries(value)) {
    if (key.length > 0 && typeof id === "string" && id.length > 0 && id !== key) kept[key] = id;
    else dropped.push(`${label}.${key}`);
  }
  return kept;
}

/**
 * Derived fields on a stored concept are never trusted. `mergedInto` comes
 * from `merges` alone and is stripped; `additionalSources` keeps only its
 * well-formed entries, so a malformed one can never reach the Tutor's TEACH
 * step or a Study card. Status is left exactly as stored.
 */
function sanitizeStoredConcept(concept: Concept, index: number, dropped: string[]): Concept {
  const { mergedInto, additionalSources, ...rest } = concept as Concept & { mergedInto?: unknown; additionalSources?: unknown };
  if (mergedInto !== undefined) dropped.push(`concepts[${index}].mergedInto`);
  if (additionalSources === undefined) return rest;
  if (!Array.isArray(additionalSources)) {
    dropped.push(`concepts[${index}].additionalSources`);
    return rest;
  }
  const kept = additionalSources.filter((source, i) => {
    const ok = sourceShape(source);
    if (!ok) dropped.push(`concepts[${index}].additionalSources[${i}]`);
    return ok;
  });
  return kept.length > 0 ? { ...rest, additionalSources: kept } : rest;
}

/**
 * Upgrade stored state to the current shape.
 *
 * Milestone 1 stored approval decisions only. Those are preserved: a concept
 * the user already approved must not silently revert to DRAFT.
 */
export function migrateOverrides(stored: unknown): CurriculumOverrides | null {
  return sanitizeOverrides(stored)?.overrides ?? null;
}

/**
 * `migrateOverrides`, plus the list of stored entries that were dropped as
 * malformed (so the repository can write the clean version back). Null only
 * when the store as a whole is unreadable: unknown version, or the core
 * decision and content records are not what this app writes.
 */
export function sanitizeOverrides(stored: unknown): { overrides: CurriculumOverrides; dropped: string[] } | null {
  if (!record(stored)) return null;
  const value = stored as Partial<CurriculumOverrides>;
  const KNOWN_VERSIONS = [1, 2, 3, CURRICULUM_OVERRIDES_VERSION];
  if (typeof value.version !== "number" || !KNOWN_VERSIONS.includes(value.version)) {
    return null;
  }
  if (!record(value.statusById) || !Object.values(value.statusById).every(status)) return null;
  if (value.edits !== undefined && (!record(value.edits) || !Object.values(value.edits).every((edit) => record(edit) &&
    (edit.title === undefined || typeof edit.title === "string") && (edit.summary === undefined || typeof edit.summary === "string")))) return null;
  if (value.cardEdits !== undefined && (!record(value.cardEdits) || !Object.values(value.cardEdits).every((edit) => record(edit) &&
    (edit.prompt === undefined || typeof edit.prompt === "string") && (edit.explanation === undefined || typeof edit.explanation === "string")))) return null;
  const dropped: string[] = [];
  const merges = sanitizeIdMap(value.merges, "merges", dropped);
  const keptApart = sanitizeIdMap(value.keptApart, "keptApart", dropped);
  if (value.lectures !== undefined && (!Array.isArray(value.lectures) || !value.lectures.every(lectureShape))) return null;
  if (value.concepts !== undefined && (!Array.isArray(value.concepts) || !value.concepts.every(conceptShape))) return null;
  if (value.ingested !== undefined && (!Array.isArray(value.ingested) || !value.ingested.every((entry) => record(entry) &&
    textFields(entry, ["lectureId", "ingestedAt"]) && documentShape(entry.document) && Array.isArray(entry.chunks) && entry.chunks.every(chunkShape)))) return null;

  const migrated: CurriculumOverrides = {
    version: CURRICULUM_OVERRIDES_VERSION,
    statusById: value.statusById,
    edits: value.edits ?? {},
    cardEdits: value.cardEdits ?? {},
    merges,
    keptApart,
    lectures: value.lectures ?? [],
    ingested: value.ingested ?? [],
    concepts: (value.concepts ?? []).map((concept, index) => sanitizeStoredConcept(concept, index, dropped)),
  };
  // An old same-name upload could replace a document's text while keeping the
  // previous reviewer's decisions, because both took the same colliding id.
  //
  // Every review artefact tied to such an id is therefore untrustworthy, not
  // just an approval: a DISCARD may have judged content that is no longer
  // there, and an EDIT may have rewritten a different document's concept. All
  // of it is dropped so the material is reviewed again from scratch against
  // whatever text is actually stored now.
  //
  // Version 3 performed only half of this (it reset ACTIVE and kept edits), so
  // stores already at v3 are cleaned again here.
  if (value.version < CURRICULUM_OVERRIDES_VERSION) {
    const legacyDocuments = new Set(
      migrated.ingested
        .filter((entry) => hasLegacyDocumentIdentity(entry.document.id))
        .map((entry) => entry.document.id),
    );

    const statusById = { ...migrated.statusById };
    const edits = { ...migrated.edits };
    for (const concept of migrated.concepts) {
      const untrusted =
        legacyDocuments.has(concept.source.documentId) ||
        hasLegacyDocumentIdentity(concept.source.documentId);
      if (!untrusted) continue;
      // Reset regardless of what the decision was — ACTIVE, DISCARDED or an
      // edit. Authored Milestone 1 ids never collided and are left alone.
      statusById[concept.id] = "DRAFT";
      delete edits[concept.id];
    }
    migrated.statusById = statusById;
    migrated.edits = edits;
  }

  return { overrides: migrated, dropped };
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
 * Card wording edits apply by item id, after any concept edit has rebuilt the
 * items: a card that still exists keeps its id, and so its FSRS history.
 */
function applyCardEdits(concept: Concept, cardEdits: Record<string, CardEdit>): Concept {
  let changed = false;
  const retrievalItems = concept.retrievalItems.map((item) => {
    const edit = cardEdits[item.id];
    const prompt = edit?.prompt?.trim();
    const explanation = edit?.explanation?.trim();
    if (!prompt && !explanation) return item;
    changed = true;
    return { ...item, prompt: prompt || item.prompt, explanation: explanation || item.explanation };
  });
  return changed ? { ...concept, retrievalItems } : concept;
}

/**
 * Record a card wording edit. Never touches concept status or grading.
 */
export function editCard(
  overrides: CurriculumOverrides,
  itemId: string,
  edit: CardEdit,
): CurriculumOverrides {
  const existing = overrides.cardEdits[itemId] ?? {};
  return { ...overrides, cardEdits: { ...overrides.cardEdits, [itemId]: { ...existing, ...edit } } };
}

/** Follow merge chains to the concept that finally survives; null on a cycle. */
export function resolveMergeTarget(merges: Record<string, string>, conceptId: string): string | null {
  let current = conceptId;
  const seen = new Set<string>([current]);
  while (merges[current] !== undefined) {
    current = merges[current]!;
    if (seen.has(current)) return null;
    seen.add(current);
  }
  return current;
}

export class MergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeError";
  }
}

/**
 * Record that `duplicateId` duplicates `canonicalId`. A reviewer's explicit
 * decision: the duplicate is DISCARDED (it can never be taught, studied or
 * scheduled on its own), and `applyOverrides` moves its teaching pages and
 * provenance to the canonical. The canonical's status is NOT changed —
 * merging never approves anything.
 */
export function mergeConcepts(
  overrides: CurriculumOverrides,
  curriculum: Curriculum,
  duplicateId: string,
  canonicalId: string,
): CurriculumOverrides {
  if (duplicateId === canonicalId) throw new MergeError("a concept cannot be merged into itself");
  const live = applyOverrides(curriculum, overrides);
  const duplicate = live.concepts.find((c) => c.id === duplicateId);
  const canonical = live.concepts.find((c) => c.id === canonicalId);
  if (!duplicate || !canonical) throw new MergeError("unknown concept");
  if (duplicate.mergedInto) throw new MergeError("already merged");
  if (canonical.mergedInto || canonical.status === "DISCARDED") {
    throw new MergeError("the canonical concept is discarded or merged itself");
  }
  const merges = { ...overrides.merges, [duplicateId]: canonicalId };
  if (resolveMergeTarget(merges, canonicalId) === null) throw new MergeError("merge would form a cycle");
  const keptApart = { ...overrides.keptApart };
  delete keptApart[duplicateId];
  return {
    ...overrides,
    merges,
    keptApart,
    statusById: { ...overrides.statusById, [duplicateId]: "DISCARDED" },
  };
}

/** Undo a merge: the concept returns to DRAFT for review, never straight to ACTIVE. */
export function unmergeConcept(overrides: CurriculumOverrides, duplicateId: string): CurriculumOverrides {
  if (overrides.merges[duplicateId] === undefined) return overrides;
  const merges = { ...overrides.merges };
  delete merges[duplicateId];
  return { ...overrides, merges, statusById: { ...overrides.statusById, [duplicateId]: "DRAFT" } };
}

/**
 * A reviewer decided two suggested duplicates are different concepts. A
 * concept that is merged by now (in another tab, since this one loaded) is
 * left merged: the newer decision wins, and Undo is the explicit way back.
 */
export function keepApart(overrides: CurriculumOverrides, conceptId: string, canonicalId: string): CurriculumOverrides {
  if (overrides.merges[conceptId] !== undefined) return overrides;
  return { ...overrides, keptApart: { ...overrides.keptApart, [conceptId]: canonicalId } };
}

/**
 * Apply merges to composed concepts and chunks: the duplicate is marked and
 * DISCARDED, the canonical gains the duplicate's source as extra provenance,
 * and every chunk that taught the duplicate teaches the canonical instead
 * (so the duplicate's pages remain teaching material for the idea).
 */
function applyMerges(
  concepts: Concept[],
  lectures: Lecture[],
  merges: Record<string, string>,
): { concepts: Concept[]; lectures: Lecture[] } {
  const ids = new Set(concepts.map((c) => c.id));
  const target = new Map<string, string>();
  for (const duplicateId of Object.keys(merges)) {
    const resolved = resolveMergeTarget(merges, duplicateId);
    // Dangling or cyclic merges are ignored rather than trusted.
    if (resolved && resolved !== duplicateId && ids.has(resolved) && ids.has(duplicateId)) target.set(duplicateId, resolved);
  }
  if (target.size === 0) return { concepts, lectures };

  const extra = new Map<string, SourceRef[]>();
  const byId = new Map(concepts.map((c) => [c.id, c]));
  for (const [duplicateId, canonicalId] of target) {
    const duplicate = byId.get(duplicateId)!;
    const list = extra.get(canonicalId) ?? [];
    list.push(duplicate.source);
    extra.set(canonicalId, list);
  }
  const merged = concepts.map((concept) => {
    const into = target.get(concept.id);
    if (into) return { ...concept, status: "DISCARDED" as const, mergedInto: into };
    const sources = extra.get(concept.id);
    if (!sources) return concept;
    const own = `${concept.source.documentId}#${concept.source.pageNumber}`;
    const seen = new Set<string>([own]);
    const additionalSources = [...(concept.additionalSources ?? []), ...sources]
      .filter((s) => {
        const key = `${s.documentId}#${s.pageNumber}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.documentId.localeCompare(b.documentId) || a.pageNumber - b.pageNumber);
    return { ...concept, additionalSources };
  });
  const rewritten = lectures.map((lecture) => ({
    ...lecture,
    chunks: lecture.chunks.map((chunk) => {
      const conceptIds: string[] = [];
      for (const id of chunk.conceptIds) {
        const next = target.get(id) ?? id;
        if (!conceptIds.includes(next)) conceptIds.push(next);
      }
      return conceptIds.length === chunk.conceptIds.length && conceptIds.every((id, i) => id === chunk.conceptIds[i])
        ? chunk
        : { ...chunk, conceptIds };
    }),
  }));
  return { concepts: merged, lectures: rewritten };
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
      const edited = applyCardEdits(applyEdit(concept, overrides.edits[concept.id]), overrides.cardEdits);
      const status = overrides.statusById[concept.id];
      return status ? { ...edited, status } : edited;
    },
  );

  const applied = applyMerges(allConcepts, lectures, overrides.merges);
  return {
    course: { ...curriculum.course, lectures: applied.lectures.sort((a, b) => a.order - b.order) },
    concepts: applied.concepts,
  };
}

/**
 * Record an approval decision. A merged duplicate is DISCARDED for as long
 * as its merge exists, so a decision about it — including a stale approval
 * from a tab that has not seen the merge — is not recorded; Undo merge is
 * the only way back, and it returns the concept to DRAFT.
 */
export function setConceptStatus(
  overrides: CurriculumOverrides,
  conceptId: string,
  status: ConceptStatus,
): CurriculumOverrides {
  if (overrides.merges[conceptId] !== undefined) return overrides;
  return {
    ...overrides,
    statusById: { ...overrides.statusById, [conceptId]: status },
  };
}

/** Approve several candidates at once. Merged duplicates in the list are skipped (see `setConceptStatus`). */
export function setConceptStatuses(
  overrides: CurriculumOverrides,
  conceptIds: readonly string[],
  status: ConceptStatus,
): CurriculumOverrides {
  const statusById = { ...overrides.statusById };
  for (const id of conceptIds) {
    if (overrides.merges[id] === undefined) statusById[id] = status;
  }
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
