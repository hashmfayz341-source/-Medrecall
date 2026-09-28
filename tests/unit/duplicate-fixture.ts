import { pathologyCurriculum as C } from "@/lib/content/pathology";
import { addIngestedDocument, applyOverrides, createOverrides, type CurriculumOverrides } from "@/lib/domain/curriculum";
import type { Concept, Curriculum, SourceDocument, TeachingChunk } from "@/lib/domain/types";

/**
 * A second document uploaded into Lecture 2 whose first sentence repeats the
 * authored `c-hypoxia` concept. Shared by the duplicate-merge suites.
 */

export const L1 = "lecture-cell-injury";
export const L2 = "lecture-inflammation";
export const DOC = `doc-lecture-inflammation-${"b".repeat(64)}`;
export const DOC2 = `doc-lecture-inflammation-${"c".repeat(64)}`;
export const DUP = `${DOC}-p1-c0`;
export const OTHER = `${DOC}-p1-c1`;
export const CHUNK = `${DOC}-chunk-1`;
export const HYPOXIA = "c-hypoxia";
export const T0 = new Date("2026-06-01T09:00:00.000Z");

export const document: SourceDocument = {
  id: DOC,
  lectureId: L2,
  title: "Inflammation handout",
  pages: [
    {
      number: 1,
      title: "Recap",
      text: "Hypoxia is the most common cause of cell injury. Neutrophils are the first cells to arrive in acute inflammation.",
    },
  ],
};

export const document2: SourceDocument = {
  id: DOC2,
  lectureId: L2,
  title: "Inflammation summary deck",
  pages: [{ number: 1, title: "Summary", text: "Summary slide." }],
};

export function candidate(id: string, title: string, summary: string, excerpt: string, documentId: string = DOC): Concept {
  return {
    id,
    courseId: "course-pathology",
    lectureId: L2,
    title,
    summary,
    importance: "CORE",
    status: "DRAFT",
    prerequisiteIds: [],
    source: { courseId: "course-pathology", lectureId: L2, documentId, pageNumber: 1, excerpt },
    retrievalItems: [
      { id: `${id}-r1`, conceptId: id, kind: "CLOZE", prompt: `___ ${summary}`, requiredKeywords: [[title.toLowerCase()]], acceptableAnswers: [title], explanation: summary },
      { id: `${id}-r2`, conceptId: id, kind: "BASIC", prompt: `What does the handout state about ${title}?`, requiredKeywords: [[title.toLowerCase()]], acceptableAnswers: [], explanation: summary },
    ],
  };
}

export const hypoxiaTitle = C.concepts.find((c) => c.id === HYPOXIA)!.title;
export const dup = candidate(DUP, hypoxiaTitle, "Hypoxia is the most common cause of cell injury.", "Hypoxia is the most common cause of cell injury.");
export const other = candidate(OTHER, "Neutrophils", "Neutrophils are the first cells to arrive in acute inflammation.", "Neutrophils are the first cells to arrive in acute inflammation.");
export const chunk: TeachingChunk = {
  id: CHUNK,
  lectureId: L2,
  order: 10,
  title: "Recap",
  documentId: DOC,
  pageNumbers: [1],
  conceptIds: [DUP, OTHER],
  explanation: "generated",
  generated: true,
};

export function withUpload(concepts: readonly Concept[] = [dup, other]): CurriculumOverrides {
  return addIngestedDocument(createOverrides(), { lectureId: L2, document, chunks: [chunk], ingestedAt: T0.toISOString() }, concepts);
}

/** The handout plus a second document in the same lecture, each with its own candidates. */
export function withTwoUploads(first: readonly Concept[], second: readonly Concept[]): CurriculumOverrides {
  const chunk2: TeachingChunk = { ...chunk, id: `${DOC2}-chunk-1`, documentId: DOC2, order: 11, conceptIds: second.map((c) => c.id) };
  return addIngestedDocument(withUpload(first), { lectureId: L2, document: document2, chunks: [chunk2], ingestedAt: T0.toISOString() }, second);
}

export const live = (o: CurriculumOverrides): Curriculum => applyOverrides(C, o);
