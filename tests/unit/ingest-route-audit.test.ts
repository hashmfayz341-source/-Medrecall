import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/ingest/route";
import { addIngestedDocument, applyOverrides, createOverrides, setConceptStatus } from "@/lib/domain/curriculum";
import { buildChunks } from "@/lib/ingestion/extractor";
import { LocalStorageCurriculumRepository } from "@/lib/persistence/curriculumStore";
import { LocalStorageLearnerRepository } from "@/lib/persistence/localStorage";
import { createLearnerState } from "@/lib/engine/tutor";
import { gradeAnswer } from "@/lib/grading";
import type { Concept, Curriculum } from "@/lib/domain/types";
import { makePdf } from "../fixtures/make-pdf";

afterEach(() => vi.unstubAllGlobals());
function request(data: Uint8Array, name = "lecture.pdf", lecture = "first") {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(data)], name, { type: "application/pdf" }));
  form.set("courseId", "course");
  form.set("lectureId", lecture);
  return new Request("http://localhost/api/ingest", { method: "POST", body: form });
}

describe("independent ingestion API checks", () => {
  it("isolates the same PDF in different lectures, including review and provenance", async () => {
    const bytes = readFileSync("tests/fixtures/renal-short.pdf");
    const a = await (await POST(request(bytes))).json();
    const b = await (await POST(request(bytes, "lecture.pdf", "second"))).json();
    expect(a.document.id).not.toBe(b.document.id);
    expect(a.concepts[0].id).not.toBe(b.concepts[0].id);
    let overrides = createOverrides();
    for (const result of [a, b]) {
      overrides = addIngestedDocument(overrides, { lectureId: result.document.lectureId, document: result.document,
        chunks: buildChunks(result.document, result.document.lectureId, result.concepts, 0), ingestedAt: new Date().toISOString() }, result.concepts);
    }
    overrides = setConceptStatus(overrides, a.concepts[0].id, "ACTIVE");
    const base: Curriculum = { course: { id: "course", title: "Audit", description: "", lectures: ["first", "second"].map((id, index) => ({ id, title: id, courseId: "course", order: index + 1, chunks: [], documents: [] })) }, concepts: [] };
    const live = applyOverrides(base, overrides);
    expect(live.course.lectures.map(l => l.documents.length)).toEqual([1, 1]);
    expect(live.concepts.find(c => c.id === b.concepts[0].id)?.status).toBe("DRAFT");
    for (const concept of live.concepts) {
      const source = live.course.lectures.find(l => l.id === concept.source.lectureId)!.documents.find(d => d.id === concept.source.documentId)!;
      expect(source.pages.find(p => p.number === concept.source.pageNumber)!.text).toContain(concept.source.excerpt);
    }
  });

  it("reuploading unchanged material does not reorder its chunks", async () => {
    const result = await (await POST(request(readFileSync("tests/fixtures/renal-short.pdf")))).json();
    const ingested = { lectureId: "first", document: result.document, chunks: buildChunks(result.document, "first", result.concepts, 0), ingestedAt: new Date().toISOString() };
    const once = addIngestedDocument(createOverrides(), ingested, result.concepts);
    const twice = addIngestedDocument(once, { ...ingested, chunks: buildChunks(result.document, "first", result.concepts, 8) }, result.concepts);
    expect(twice.ingested[0]!.chunks.map(c => c.order)).toEqual(once.ingested[0]!.chunks.map(c => c.order));
  });

  it("changed same-name files cannot inherit an earlier approval", async () => {
    const a = await (await POST(request(readFileSync("tests/fixtures/cell-injury.pdf")))).json();
    const b = await (await POST(request(readFileSync("tests/fixtures/renal-short.pdf")))).json();
    expect(a.document.id).not.toBe(b.document.id);
    const previouslyApproved = new Set(a.concepts.map((c: Concept) => c.id));
    expect(b.concepts.every((c: Concept) => c.status === "DRAFT" && !previouslyApproved.has(c.id))).toBe(true);
  });

  it.each([
    ["empty upload", new Uint8Array(), 400, "empty"],
    ["malformed PDF", new TextEncoder().encode("not a PDF"), 422, "Could not read"],
    ["blank page", makePdf([[]]), 422, "No text"],
    ["image-only PDF", makePdf([[]], true), 422, "No text"],
    ["zero-page PDF", makePdf([]), 422, "No text"],
    ["oversized file", new Uint8Array(12 * 1024 * 1024 + 1), 413, "larger than"],
    ["text without extractable candidates", makePdf([["Title only"]]), 422, "No candidate"],
  ])("returns an actionable error for %s", async (_label, bytes, status, message) => {
    const response = await POST(request(bytes as Uint8Array));
    expect(response.status).toBe(status);
    expect((await response.json()).error).toContain(message);
  });

  it("rejects a non-multipart request and missing metadata", async () => {
    expect((await POST(new Request("http://localhost/api/ingest", { method: "POST", body: "wrong" }))).status).toBe(400);
    const form = new FormData();
    form.set("file", new File(["pdf"], "x.pdf"));
    expect((await POST(new Request("http://localhost/api/ingest", { method: "POST", body: form }))).status).toBe(400);
  });

  it("accepts a readable file at the 12 MiB boundary", async () => {
    const pdf = makePdf([["Hypoxia is a cause of cell injury."]]);
    const padded = new Uint8Array(12 * 1024 * 1024).fill(32);
    padded.set(pdf);
    const response = await POST(request(padded));
    expect(response.status).toBe(200);
    expect((await response.json()).stats.pages).toBe(1);
  });

  it("preserves wrapped/hyphenated source spans and deduplicates repeated sentences", async () => {
    const response = await POST(request(makePdf([["Cell Injury", "Hypoxia is a cause of cell injury.", "Hypoxia is a cause of cell injury.", "The sodium-", "potassium pump consumes cellular ATP.", "Page 1"]])));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.concepts.filter((c: Concept) => c.title === "Hypoxia")).toHaveLength(1);
    expect(result.document.pages[0].text).toContain("Cell Injury");
    expect(result.document.pages[0].text).toContain("Page 1");
    for (const concept of result.concepts) expect(result.document.pages[0].text).toContain(concept.source.excerpt);
  });

  it("preserves page numbers around blank pages and emits only grounded drafts", async () => {
    const response = await POST(request(makePdf([["Hypoxia is a cause of cell injury."], [], ["Necrosis is a form of cell death."]])));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.document.pages.map((p: { number: number }) => p.number)).toEqual([1, 2, 3]);
    expect(result.concepts.map((c: Concept) => c.source.pageNumber)).toEqual([1, 3]);
    expect(result.stats.pagesWithText).toBe(2);
    expect(result.concepts.every((c: Concept) => c.status === "DRAFT")).toBe(true);
  });

  it("reports failed storage writes instead of swallowing a quota error", () => {
    vi.stubGlobal("window", { localStorage: { setItem() { throw new Error("QuotaExceededError"); } } });
    expect(new LocalStorageCurriculumRepository().save(createOverrides())).toBe(false);
    expect(new LocalStorageLearnerRepository().save(createLearnerState())).toBe(false);
  });

  it("medical Greek letters remain distinct and superscript ion notation is accepted", () => {
    const base = { id: "item", conceptId: "c", kind: "CLOZE" as const, prompt: "", explanation: "", acceptableAnswers: [] };
    expect(gradeAnswer({ ...base, requiredKeywords: [["β-blocker"]] }, "α-blocker").correct).toBe(false);
    expect(gradeAnswer({ ...base, requiredKeywords: [["Na⁺/K⁺ ATPase"]] }, "Na+/K+ ATPase").correct).toBe(true);
  });
});
