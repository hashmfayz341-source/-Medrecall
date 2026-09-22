import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { extractPdfPages, documentIdFor, splitHeading, linesFromItems } from "@/lib/ingestion/pdf";
import {
  buildChunks,
  chunkPageNumbers,
  generateCandidates,
  splitSentences,
  splitSubjectPredicate,
  titleFromSubject,
  toSourceDocument,
} from "@/lib/ingestion/extractor";
import { DeterministicProvider } from "@/lib/ai";
import type { Concept } from "@/lib/domain/types";
import type { ExtractedDocument } from "@/lib/ingestion/pdf";

const COURSE = "course-pathology";
const LECTURE = "lecture-cell-injury";

let doc: ExtractedDocument;
let candidates: Concept[];

beforeAll(async () => {
  const bytes = new Uint8Array(readFileSync("tests/fixtures/cell-injury.pdf"));
  doc = await extractPdfPages(bytes, "cell-injury.pdf");
  candidates = generateCandidates(doc, { courseId: COURSE, lectureId: LECTURE });
});

describe("PDF extraction", () => {
  it("reads every page of the document", () => {
    expect(doc.pageCount).toBe(4);
    expect(doc.pages).toHaveLength(4);
  });

  it("REQUIREMENT 1: pages remain in the correct order", () => {
    expect(doc.pages.map((p) => p.number)).toEqual([1, 2, 3, 4]);

    // Order is not just numeric — the content must match the right page.
    expect(doc.pages[0]!.text).toContain("Hypoxia is the most common cause");
    expect(doc.pages[1]!.text).toContain("ATP depletion");
    expect(doc.pages[2]!.text).toContain("Cellular swelling");
    expect(doc.pages[3]!.text).toContain("Severe membrane damage");
  });

  it("REQUIREMENT 2: page numbers are preserved and 1-indexed", () => {
    for (const [index, page] of doc.pages.entries()) {
      expect(page.number).toBe(index + 1);
    }
  });

  it("does not flatten the document into one blob", () => {
    // Page 1 content must not leak into page 4.
    expect(doc.pages[3]!.text).not.toContain("Hypoxia is the most common cause");
    const joined = doc.pages.map((p) => p.text).join(" ");
    expect(joined.length).toBeGreaterThan(doc.pages[0]!.text.length);
  });

  it("captures each page heading", () => {
    expect(doc.pages.map((p) => p.title)).toEqual([
      "Cell Injury: Overview",
      "The ATP Depletion Cascade",
      "Morphology of Reversible Injury",
      "Irreversible Injury",
    ]);
  });

  it("preserves document identity across identical uploads", async () => {
    const bytes = new Uint8Array(readFileSync("tests/fixtures/cell-injury.pdf"));
    const again = await extractPdfPages(bytes, "cell-injury.pdf");
    expect(again.id).toBe(doc.id);
  });

  it("gives different documents different ids", () => {
    const a = documentIdFor("a.pdf", new Uint8Array([1, 2, 3]));
    const b = documentIdFor("a.pdf", new Uint8Array([1, 2, 4]));
    const c = documentIdFor("b.pdf", new Uint8Array([1, 2, 3]));
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("handles a shorter document", async () => {
    const bytes = new Uint8Array(readFileSync("tests/fixtures/renal-short.pdf"));
    const short = await extractPdfPages(bytes, "renal-short.pdf");
    expect(short.pages.map((p) => p.number)).toEqual([1, 2]);
    expect(short.pages[1]!.text).toContain("proximal tubule");
  });

  it("rejects bytes that are not a PDF", async () => {
    await expect(
      extractPdfPages(new TextEncoder().encode("not a pdf at all"), "x.pdf"),
    ).rejects.toBeDefined();
  });
});

describe("extraction helpers", () => {
  it("rebuilds lines from text items", () => {
    expect(
      linesFromItems([
        { str: "Hello ", hasEOL: false },
        { str: "world", hasEOL: true },
        { str: "second", hasEOL: true },
      ]),
    ).toEqual(["Hello world", "second"]);
  });

  it("treats a short non-sentence first line as a heading", () => {
    expect(splitHeading(["Cell Injury", "It is bad."], 3)).toEqual({
      title: "Cell Injury",
      body: "It is bad.",
    });
  });

  it("falls back to the page number when there is no heading", () => {
    expect(splitHeading(["This is a full sentence."], 7).title).toBe("Page 7");
  });

  it("splits sentences without breaking on decimals mid-word", () => {
    expect(splitSentences("One thing. Two things. Three.")).toHaveLength(3);
  });

  it("finds the subject/predicate boundary", () => {
    const split = splitSubjectPredicate(
      "The sodium potassium pump consumes a large share of ATP.",
    );
    expect(split?.subject).toBe("The sodium potassium pump");
    expect(split?.predicate).toBe("consumes a large share of ATP.");
  });

  it("returns null when no verb boundary exists", () => {
    expect(splitSubjectPredicate("Short phrase")).toBeNull();
  });

  it("strips leading articles from titles", () => {
    expect(titleFromSubject("The proximal tubule")).toBe("Proximal tubule");
  });

  it("rejects titles that are too long to be a concept name", () => {
    expect(titleFromSubject("one two three four five six seven eight nine")).toBeNull();
  });

  it("groups pages into 2-5 page chunks", () => {
    expect(chunkPageNumbers([1, 2, 3, 4])).toEqual([[1, 2], [3, 4]]);
    expect(chunkPageNumbers([1, 2])).toEqual([[1, 2]]);
    expect(chunkPageNumbers([1, 2, 3, 4, 5])).toEqual([[1, 2, 3], [4, 5]]);
    for (const group of chunkPageNumbers([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])) {
      expect(group.length).toBeGreaterThanOrEqual(2);
      expect(group.length).toBeLessThanOrEqual(5);
    }
  });
});

describe("candidate concept generation", () => {
  it("produces candidates from the document", () => {
    expect(candidates.length).toBeGreaterThan(5);
  });

  it("REQUIREMENT 3: every candidate is created as DRAFT", () => {
    for (const concept of candidates) {
      expect(concept.status, concept.id).toBe("DRAFT");
    }
    expect(candidates.some((c) => c.status === "ACTIVE")).toBe(false);
  });

  it("REQUIREMENT 4: every candidate carries a complete SourceRef", () => {
    for (const concept of candidates) {
      expect(concept.source.courseId, concept.id).toBe(COURSE);
      expect(concept.source.lectureId, concept.id).toBe(LECTURE);
      expect(concept.source.documentId, concept.id).toBe(doc.id);
      expect(concept.source.pageNumber, concept.id).toBeGreaterThan(0);
      expect(concept.source.excerpt.length, concept.id).toBeGreaterThan(10);
    }
  });

  it("every excerpt is verbatim text from the page it cites", () => {
    for (const concept of candidates) {
      const page = doc.pages.find((p) => p.number === concept.source.pageNumber);
      expect(page, concept.id).toBeDefined();
      expect(page!.text, concept.id).toContain(concept.source.excerpt);
    }
  });

  it("invents nothing: the explanation IS the source sentence", () => {
    for (const concept of candidates) {
      expect(concept.summary).toBe(concept.source.excerpt);
    }
  });

  it("every title is a span of its own source sentence", () => {
    for (const concept of candidates) {
      const haystack = concept.source.excerpt.toLowerCase();
      expect(haystack, concept.id).toContain(concept.title.toLowerCase());
    }
  });

  it("assigns candidates to the page they came from", () => {
    const atp = candidates.find((c) => c.title === "ATP depletion");
    expect(atp).toBeDefined();
    expect(atp!.source.pageNumber).toBe(2);

    const necrosis = candidates.find((c) => c.title === "Necrosis");
    expect(necrosis?.source.pageNumber).toBe(4);
  });

  it("does not produce duplicate titles", () => {
    const titles = candidates.map((c) => c.title.toLowerCase());
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("gives every candidate at least two retrieval forms", () => {
    for (const concept of candidates) {
      expect(concept.retrievalItems.length, concept.id).toBeGreaterThanOrEqual(2);
      for (const item of concept.retrievalItems) {
        expect(item.requiredKeywords.length, item.id).toBeGreaterThan(0);
        expect(item.conceptId, item.id).toBe(concept.id);
      }
    }
  });

  it("only links prerequisites that appear literally in the source sentence", () => {
    for (const concept of candidates) {
      for (const prereqId of concept.prerequisiteIds) {
        const prereq = candidates.find((c) => c.id === prereqId);
        expect(prereq, `${concept.id} -> ${prereqId}`).toBeDefined();
        expect(concept.source.excerpt.toLowerCase()).toContain(
          prereq!.title.toLowerCase(),
        );
        expect(prereqId).not.toBe(concept.id);
      }
    }
  });

  it("is deterministic across runs", () => {
    const again = generateCandidates(doc, { courseId: COURSE, lectureId: LECTURE });
    expect(again).toEqual(candidates);
  });

  it("routes through the provider abstraction and still yields DRAFT", async () => {
    const provider = new DeterministicProvider();
    const viaProvider = await provider.extractConcepts({
      courseId: COURSE,
      lectureId: LECTURE,
      document: toSourceDocument(doc, LECTURE),
    });
    expect(viaProvider).toEqual(candidates);
    expect(viaProvider.every((c) => c.status === "DRAFT")).toBe(true);
  });
});

describe("teaching chunks built from an ingested document", () => {
  it("covers every page exactly once, in order", () => {
    const chunks = buildChunks(doc, LECTURE, candidates, 0);
    const pages = chunks.flatMap((c) => c.pageNumbers);
    expect(pages).toEqual([1, 2, 3, 4]);
  });

  it("assigns each candidate to the chunk containing its page", () => {
    const chunks = buildChunks(doc, LECTURE, candidates, 0);
    for (const concept of candidates) {
      const owner = chunks.find((c) => c.conceptIds.includes(concept.id));
      expect(owner, concept.id).toBeDefined();
      expect(owner!.pageNumbers).toContain(concept.source.pageNumber);
    }
  });

  it("continues the chunk ordering of an existing lecture", () => {
    const chunks = buildChunks(doc, LECTURE, candidates, 2);
    expect(chunks.map((c) => c.order)).toEqual([3, 4]);
  });

  it("stores provenance only — never the candidate sentences themselves", () => {
    // Chunks are built while every candidate is still DRAFT. Embedding their
    // sentences in the stored explanation is how unapproved text reached
    // teaching; the tutor composes the body from ACTIVE concepts at serve time.
    const chunks = buildChunks(doc, LECTURE, candidates, 0);
    for (const chunk of chunks) {
      expect(chunk.generated).toBe(true);
      expect(chunk.explanation).toContain(doc.title);
      for (const concept of candidates) {
        expect(chunk.explanation, `${chunk.id} leaks ${concept.id}`).not.toContain(
          concept.summary,
        );
      }
    }
  });
});
