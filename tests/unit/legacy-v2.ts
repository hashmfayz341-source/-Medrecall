import type { Concept, TeachingChunk, SourceDocument } from "@/lib/domain/types";

/**
 * A curriculum payload shaped exactly as Milestone 2 main (25acbcb) wrote it.
 *
 * Reproduced faithfully, including the two properties that make it dangerous:
 *   - the stored chunk explanation embeds EVERY candidate sentence, because it
 *     was assembled at ingest time while all candidates were still DRAFT
 *   - there is no `generated` flag, because the field did not exist yet
 *   - the document id carries the 8-hex legacy identity that could collide
 */

export const LEGACY_DOC_ID = "doc-lecture-811c9dc5";
export const LEGACY_LECTURE = "lecture-legacy";
export const LEGACY_COURSE = "course-pathology";

export const LEGACY_SENTENCES = {
  approved: "Hypoxia is the most common cause of cell injury.",
  discarded: "Karyorrhexis is the discarded fragmentation of the nucleus.",
  draftA: "Pyknosis is the unapproved condensation of nuclear chromatin.",
  draftB: "Karyolysis is the unapproved fading of nuclear basophilia.",
} as const;

/** The raw PDF heading, which belongs to the concept that gets DISCARDED. */
export const LEGACY_PAGE_HEADING = "Karyorrhexis and nuclear breakdown";

function legacyConcept(
  id: string,
  title: string,
  sentence: string,
  pageNumber: number,
): Concept {
  return {
    id,
    courseId: LEGACY_COURSE,
    lectureId: LEGACY_LECTURE,
    title,
    summary: sentence,
    importance: "SUPPORTING",
    status: "DRAFT",
    prerequisiteIds: [],
    source: {
      courseId: LEGACY_COURSE,
      lectureId: LEGACY_LECTURE,
      documentId: LEGACY_DOC_ID,
      pageNumber,
      excerpt: sentence,
    },
    retrievalItems: [
      {
        id: `${id}-r1`,
        conceptId: id,
        kind: "CLOZE",
        prompt: `___ ${sentence}`,
        requiredKeywords: [[title.toLowerCase()]],
        acceptableAnswers: [title],
        explanation: sentence,
      },
      {
        id: `${id}-r2`,
        conceptId: id,
        kind: "BASIC",
        prompt: `What does the source state about ${title}?`,
        requiredKeywords: [[title.toLowerCase()]],
        acceptableAnswers: [],
        explanation: sentence,
      },
    ],
  };
}

export const LEGACY_CONCEPTS: Concept[] = [
  legacyConcept("legacy-c0", "Hypoxia", LEGACY_SENTENCES.approved, 1),
  legacyConcept("legacy-c1", "Karyorrhexis", LEGACY_SENTENCES.discarded, 1),
  legacyConcept("legacy-c2", "Pyknosis", LEGACY_SENTENCES.draftA, 1),
  legacyConcept("legacy-c3", "Karyolysis", LEGACY_SENTENCES.draftB, 1),
];

export const LEGACY_DOCUMENT: SourceDocument = {
  id: LEGACY_DOC_ID,
  lectureId: LEGACY_LECTURE,
  title: "Lecture",
  pages: [
    {
      number: 1,
      title: LEGACY_PAGE_HEADING,
      text: Object.values(LEGACY_SENTENCES).join(" "),
    },
  ],
};

/** Exactly what old `buildChunks` produced: no flag, every sentence inlined. */
export const LEGACY_CHUNK: TeachingChunk = {
  id: `${LEGACY_DOC_ID}-chunk-1`,
  lectureId: LEGACY_LECTURE,
  order: 1,
  title: LEGACY_PAGE_HEADING,
  documentId: LEGACY_DOC_ID,
  pageNumbers: [1],
  conceptIds: LEGACY_CONCEPTS.map((c) => c.id),
  explanation:
    `From Lecture, page 1 (${LEGACY_PAGE_HEADING}).\n\n` +
    `The following statements are taken directly from the source:\n` +
    LEGACY_CONCEPTS.map((c) => `• ${c.summary}`).join("\n"),
};

/** A complete v2 store, as written by Milestone 2 main. */
export function legacyV2Payload(statusById: Record<string, string> = {}) {
  return {
    version: 2,
    statusById,
    edits: {},
    lectures: [
      {
        id: LEGACY_LECTURE,
        courseId: LEGACY_COURSE,
        title: "Legacy lecture",
        // Ordered first so the test exercises teaching, not the unlock gate.
        order: 0,
        documents: [],
        chunks: [],
      },
    ],
    ingested: [
      {
        lectureId: LEGACY_LECTURE,
        document: LEGACY_DOCUMENT,
        chunks: [LEGACY_CHUNK],
        ingestedAt: "2026-09-20T10:00:00.000Z",
      },
    ],
    concepts: LEGACY_CONCEPTS,
  };
}
