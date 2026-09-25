import { describe, expect, it } from "vitest";
import { containsTerm, gradeAnswer, normalize } from "@/lib/grading";
import { getConcept, getItem } from "@/lib/engine/tutor";
import { pathologyCurriculum } from "@/lib/content/pathology";
import { DeterministicProvider } from "@/lib/ai";
import { CORRECT_ATP } from "./helpers";

const atp = getConcept(pathologyCurriculum, "c-atp-depletion");
const atp1 = getItem(atp, "c-atp-1");
const atp3 = getItem(atp, "c-atp-3");

describe("normalization", () => {
  it("lowercases and strips punctuation but keeps + and /", () => {
    expect(normalize("Na+/K+ ATPase, fails!")).toBe("na+/k+ atpase fails");
  });

  it("collapses whitespace", () => {
    expect(normalize("  a   b  ")).toBe("a b");
  });
});

describe("term matching", () => {
  it("respects word boundaries", () => {
    expect(containsTerm("the atpase failed", "atp")).toBe(false);
    expect(containsTerm("atp fell sharply", "atp")).toBe(true);
  });

  it("matches multi-word terms", () => {
    expect(containsTerm("the sodium potassium pump failed", "sodium potassium pump")).toBe(true);
  });
});

describe("deterministic grading", () => {
  it("accepts an answer covering every keyword group", () => {
    const result = gradeAnswer(atp1, CORRECT_ATP);
    expect(result.correct).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("rejects an empty answer", () => {
    expect(gradeAnswer(atp1, "   ").correct).toBe(false);
  });

  it("rejects a plausible-sounding but incomplete answer", () => {
    const result = gradeAnswer(atp1, "the sodium pump stops working");
    expect(result.correct).toBe(false);
    expect(result.missing.length).toBeGreaterThan(0);
  });

  it("reports exactly which group was missed", () => {
    const result = gradeAnswer(atp1, "the na/k atpase fails and sodium builds up");
    expect(result.correct).toBe(false);
    expect(result.missing).toEqual(["water"]);
  });

  it("accepts an exact acceptable answer", () => {
    expect(gradeAnswer(atp3, "Na/K ATPase").correct).toBe(true);
  });

  it("is deterministic: same input, same verdict, every time", () => {
    const answers = [CORRECT_ATP, "no idea", "the na/k atpase fails"];
    for (const text of answers) {
      const first = gradeAnswer(atp1, text);
      for (let i = 0; i < 25; i++) {
        expect(gradeAnswer(atp1, text)).toEqual(first);
      }
    }
  });

  it("is order-insensitive across keyword groups", () => {
    const a = gradeAnswer(atp1, "water follows sodium after the na/k atpase fails");
    const b = gradeAnswer(atp1, "the na/k atpase fails then sodium and water accumulate");
    expect(a.correct).toBe(true);
    expect(b.correct).toBe(true);
  });

  it("accepts any synonym within a group", () => {
    for (const synonym of ["na/k atpase", "sodium potassium pump", "na+/k+ atpase"]) {
      const result = gradeAnswer(atp1, `${synonym} fails so sodium and water accumulate`);
      expect(result.correct, synonym).toBe(true);
    }
  });

  it("every authored retrieval item has at least one keyword group", () => {
    for (const concept of pathologyCurriculum.concepts) {
      expect(concept.retrievalItems.length, concept.id).toBeGreaterThan(0);
      for (const item of concept.retrievalItems) {
        expect(item.requiredKeywords.length, item.id).toBeGreaterThan(0);
        expect(item.explanation.length, item.id).toBeGreaterThan(0);
      }
    }
  });
});

describe("ai provider abstraction", () => {
  const provider = new DeterministicProvider();

  it("grades through the provider identically to the pure grader", async () => {
    const viaProvider = await provider.gradeFreeAnswer({
      concept: atp,
      item: atp1,
      answer: CORRECT_ATP,
    });
    expect(viaProvider).toEqual(gradeAnswer(atp1, CORRECT_ATP));
  });

  it("extraction always yields DRAFT concepts with source provenance", async () => {
    const lecture = pathologyCurriculum.course.lectures[0]!;
    const extracted = await provider.extractConcepts({
      courseId: pathologyCurriculum.course.id,
      lectureId: lecture.id,
      document: lecture.documents[0]!,
    });
    expect(extracted.length).toBeGreaterThan(0);
    for (const concept of extracted) {
      expect(concept.status).toBe("DRAFT");
      expect(concept.source.pageNumber).toBeGreaterThan(0);
      expect(concept.source.excerpt.length).toBeGreaterThan(0);
    }
  });

  it("remediation cites the source page", async () => {
    const text = await provider.generateRemediation({
      concept: atp,
      item: atp1,
      grade: gradeAnswer(atp1, "no idea"),
      learnerAnswer: "no idea",
    });
    expect(text).toContain(`page ${atp.source.pageNumber}`);
  });
});

describe("source grounding", () => {
  it("every concept retains course, lecture, document, page and excerpt", () => {
    for (const concept of pathologyCurriculum.concepts) {
      expect(concept.source.courseId, concept.id).toBeTruthy();
      expect(concept.source.lectureId, concept.id).toBe(concept.lectureId);
      expect(concept.source.documentId, concept.id).toBeTruthy();
      expect(concept.source.pageNumber, concept.id).toBeGreaterThan(0);
      expect(concept.source.excerpt.length, concept.id).toBeGreaterThan(10);
    }
  });

  it("every source ref points at a page that actually exists", () => {
    const pages = new Map<string, Set<number>>();
    for (const lecture of pathologyCurriculum.course.lectures) {
      for (const doc of lecture.documents) {
        pages.set(doc.id, new Set(doc.pages.map((p) => p.number)));
      }
    }
    for (const concept of pathologyCurriculum.concepts) {
      expect(
        pages.get(concept.source.documentId)?.has(concept.source.pageNumber),
        concept.id,
      ).toBe(true);
    }
  });

  it("the excerpt is genuinely present on the cited page", () => {
    for (const concept of pathologyCurriculum.concepts) {
      const page = pathologyCurriculum.course.lectures
        .flatMap((l) => l.documents)
        .find((d) => d.id === concept.source.documentId)
        ?.pages.find((p) => p.number === concept.source.pageNumber);
      expect(page, concept.id).toBeDefined();
      expect(page!.text, concept.id).toContain(concept.source.excerpt);
    }
  });
});
