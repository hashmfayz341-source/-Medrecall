import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pathologyCurriculum } from "@/lib/content/pathology";
import { getConcept, getItem } from "@/lib/engine/tutor";
import { gradeAnswer } from "@/lib/grading";
import { toGradeRequest } from "@/lib/grading/request";
import { extractPdfPages } from "@/lib/ingestion/pdf";
import { generateCandidates } from "@/lib/ingestion/extractor";
import type {
  ExtractionProvider,
  GradeFreeAnswerInput,
  GradingProvider,
} from "@/lib/ai/provider";
import type { Concept } from "@/lib/domain/types";
import { CORRECT_ATP, WRONG } from "./helpers";

/**
 * H3 — grading and extraction are separate provider ROLES with separate
 * resolvers. Binding a (future, hosted) grader must not change PDF
 * extraction, make uploads call it, or require it to implement extraction —
 * and changing extraction must not change grading.
 */

// Each resolver can be substituted independently; calls are counted.
const swap = vi.hoisted(() => ({
  grading: null as unknown,
  extraction: null as unknown,
  gradingCalls: 0,
  extractionCalls: 0,
}));

vi.mock("@/lib/ai/gradingProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/gradingProvider")>();
  return {
    getGradingProvider: () => {
      swap.gradingCalls++;
      return (swap.grading as GradingProvider | null) ?? actual.getGradingProvider();
    },
  };
});

vi.mock("@/lib/ai/extractionProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/extractionProvider")>();
  return {
    getExtractionProvider: () => {
      swap.extractionCalls++;
      return (swap.extraction as ExtractionProvider | null) ?? actual.getExtractionProvider();
    },
  };
});

const { POST: GRADE } = await import("@/app/api/grade/route");
const { POST: INGEST } = await import("@/app/api/ingest/route");

const ATP = getConcept(pathologyCurriculum, "c-atp-depletion");
const ATP1 = getItem(ATP, "c-atp-1");
const PDF = readFileSync("tests/fixtures/cell-injury.pdf");
const COURSE = "course-pathology";
const LECTURE = "lecture-cell-injury";

async function grade(answer: string) {
  const response = await GRADE(
    new Request("http://localhost/api/grade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toGradeRequest(ATP, ATP1, answer)),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function ingest() {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(PDF)], "cell-injury.pdf", { type: "application/pdf" }));
  form.set("courseId", COURSE);
  form.set("lectureId", LECTURE);
  const response = await INGEST(
    new Request("http://localhost/api/ingest", { method: "POST", body: form }),
  );
  return {
    status: response.status,
    body: (await response.json()) as { concepts: Concept[]; document: { id: string } },
  };
}

/**
 * A stand-in for a Stage B hosted grader: a GRADING provider only. It has no
 * extractConcepts at all, and would blow up loudly if anything treated it as
 * an extractor.
 */
function hostedGraderStandIn() {
  const calls = { grade: 0 };
  const provider: GradingProvider & Record<string, unknown> = {
    name: "hosted-grader-stand-in",
    hosted: true,
    async gradeFreeAnswer({ item, answer }: GradeFreeAnswerInput) {
      calls.grade++;
      return gradeAnswer(item, answer);
    },
    extractConcepts: () => {
      throw new Error("a grader must never be used for extraction");
    },
  };
  return { provider, calls };
}

/** A stand-in extraction provider that also carries a hostile grader. */
function extractorStandIn() {
  const calls = { extract: 0 };
  const provider: ExtractionProvider & Record<string, unknown> = {
    name: "extractor-stand-in",
    hosted: false,
    async extractConcepts() {
      calls.extract++;
      return [];
    },
    gradeFreeAnswer: () => {
      throw new Error("an extractor must never be used for grading");
    },
  };
  return { provider, calls };
}

let baselineConcepts: Concept[];
let baselineGrades: Record<string, unknown>[];

beforeAll(async () => {
  const pages = await extractPdfPages(new Uint8Array(PDF), "cell-injury.pdf", {
    courseId: COURSE,
    lectureId: LECTURE,
  });
  baselineConcepts = generateCandidates(pages, { courseId: COURSE, lectureId: LECTURE });
  baselineGrades = [(await grade(CORRECT_ATP)).body, (await grade(WRONG)).body];
});

beforeEach(() => {
  swap.gradingCalls = 0;
  swap.extractionCalls = 0;
});

afterEach(() => {
  swap.grading = null;
  swap.extraction = null;
});

describe("H3: each route resolves its own role", () => {
  it("1. /api/grade resolves through the GRADING resolver only", async () => {
    await grade(CORRECT_ATP);
    expect(swap.gradingCalls).toBe(1);
    expect(swap.extractionCalls).toBe(0);
  });

  it("2. /api/ingest resolves through the EXTRACTION resolver only", async () => {
    const { status } = await ingest();
    expect(status).toBe(200);
    expect(swap.extractionCalls).toBe(1);
    expect(swap.gradingCalls).toBe(0);
  });
});

describe("H3: substituting one role never affects the other", () => {
  it("3. a substituted grader does not affect ingestion", async () => {
    const grader = hostedGraderStandIn();
    swap.grading = grader.provider;

    const { status, body } = await ingest();
    expect(status).toBe(200);
    expect(body.concepts).toEqual(baselineConcepts);
    expect(grader.calls.grade).toBe(0);
    expect(swap.gradingCalls).toBe(0);

    // …while grading really did switch to it.
    await grade(CORRECT_ATP);
    expect(grader.calls.grade).toBe(1);
  });

  it("4. a substituted extractor does not affect grading", async () => {
    const extractor = extractorStandIn();
    swap.extraction = extractor.provider;

    const results = [(await grade(CORRECT_ATP)).body, (await grade(WRONG)).body];
    expect(results).toEqual(baselineGrades);
    expect(extractor.calls.extract).toBe(0);
    expect(swap.extractionCalls).toBe(0);

    // …while ingestion really did switch to it (it returns nothing → 422).
    const { status } = await ingest();
    expect(status).toBe(422);
    expect(extractor.calls.extract).toBe(1);
  });

  it("5. a hosted grader cannot become the ingestion provider through one switch", () => {
    // Structural: the two resolvers are separate modules that do not import
    // each other and share no resolver function, and neither route imports
    // the barrel that exposes both.
    const grading = readFileSync("src/lib/ai/gradingProvider.ts", "utf8");
    const extraction = readFileSync("src/lib/ai/extractionProvider.ts", "utf8");
    expect(grading).not.toMatch(/extractionProvider/);
    expect(extraction).not.toMatch(/gradingProvider/);
    for (const source of [grading, extraction]) {
      expect(source).not.toMatch(/getProvider\b/);
    }

    const gradeRoute = readFileSync("src/app/api/grade/route.ts", "utf8");
    const ingestRoute = readFileSync("src/app/api/ingest/route.ts", "utf8");
    expect(gradeRoute).toMatch(/from "@\/lib\/ai\/gradingProvider"/);
    expect(gradeRoute).not.toMatch(/extractionProvider|getExtractionProvider/);
    expect(ingestRoute).toMatch(/from "@\/lib\/ai\/extractionProvider"/);
    expect(ingestRoute).not.toMatch(/gradingProvider|getGradingProvider/);
    for (const route of [gradeRoute, ingestRoute]) {
      expect(route).not.toMatch(/from "@\/lib\/ai"/);
    }

    // No ambiguous single resolver exists any more.
    expect(readFileSync("src/lib/ai/index.ts", "utf8")).not.toMatch(/export function getProvider/);
  });

  it("5b. the grading role does not require extraction (types)", () => {
    // Compiles only because GradingProvider has no extractConcepts: a Stage B
    // grader implements grading alone.
    const graderOnly: GradingProvider = {
      name: "grader-only",
      hosted: true,
      gradeFreeAnswer: async ({ item, answer }) => gradeAnswer(item, answer),
    };
    expect("extractConcepts" in graderOnly).toBe(false);
  });
});

describe("H3: parity is unchanged", () => {
  it("6. deterministic ingestion through the route equals direct candidate generation", async () => {
    const { status, body } = await ingest();
    expect(status).toBe(200);
    expect(body.concepts).toEqual(baselineConcepts);
    expect(body.concepts.length).toBeGreaterThan(0);
    expect(body.concepts.every((c) => c.status === "DRAFT")).toBe(true);
  });

  it("7. deterministic grading through the route equals the pure grader", async () => {
    const correct = await grade(CORRECT_ATP);
    const wrong = await grade(WRONG);
    expect(correct.body.grade).toEqual(gradeAnswer(ATP1, CORRECT_ATP));
    expect(wrong.body.grade).toEqual(gradeAnswer(ATP1, WRONG));
    expect(correct.body.provider).toBe("deterministic");
  });
});
