import { afterEach, describe, expect, it, vi } from "vitest";
import { pathologyCurriculum } from "@/lib/content/pathology";
import { getConcept, getItem } from "@/lib/engine/tutor";
import { gradeAnswer, type GradeResult } from "@/lib/grading";
import { toGradeRequest } from "@/lib/grading/request";
import { composeRemediation } from "@/lib/grading/remediation";
import { DeterministicProvider, type AiProvider } from "@/lib/ai";
import { CORRECT_ATP, WRONG } from "./helpers";

/**
 * H2 — the provider grades against the approved concept and its source.
 * M1 — learner-facing remediation is never free-form provider prose.
 */

const inject = vi.hoisted(() => ({ provider: null as unknown }));
vi.mock("@/lib/ai/gradingProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/gradingProvider")>();
  return {
    ...actual,
    getGradingProvider: () => (inject.provider as AiProvider | null) ?? actual.getGradingProvider(),
  };
});

const { POST } = await import("@/app/api/grade/route");

const ATP = getConcept(pathologyCurriculum, "c-atp-depletion");
const ATP1 = getItem(ATP, "c-atp-1");

async function grade(answer: string) {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const response = await POST(
    new Request("http://localhost/api/grade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toGradeRequest(ATP, ATP1, answer)),
    }),
  );
  errorSpy.mockRestore();
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** A provider built from the deterministic one with some methods replaced. */
function provider(overrides: Record<string, unknown>): AiProvider {
  const base = new DeterministicProvider();
  return Object.assign(Object.create(Object.getPrototypeOf(base)), base, overrides) as AiProvider;
}

/** The remediation the reviewed material alone produces for this item. */
async function expectedRemediation(g: GradeResult) {
  return composeRemediation({ concept: ATP, item: ATP1, grade: g });
}

afterEach(() => {
  inject.provider = null;
});

describe("H2: the provider receives the approved concept and source", () => {
  it("gradeFreeAnswer gets concept, SourceRef excerpt, item and answer in one input", async () => {
    const seen: unknown[][] = [];
    inject.provider = provider({
      gradeFreeAnswer: async (...args: unknown[]) => {
        seen.push(args);
        const input = args[0] as { item: typeof ATP1; answer: string };
        return gradeAnswer(input.item, input.answer);
      },
    });
    const { status } = await grade(CORRECT_ATP);
    expect(status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(1);
    const input = seen[0]![0] as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(["answer", "concept", "item"]);
    const concept = input.concept as { id: string; title: string; summary: string; status: string; source: { excerpt: string; pageNumber: number; documentId: string } };
    expect(concept.id).toBe(ATP.id);
    expect(concept.title).toBe(ATP.title);
    expect(concept.summary).toBe(ATP.summary);
    expect(concept.status).toBe("ACTIVE");
    expect(concept.source.excerpt).toBe(ATP.source.excerpt);
    expect(concept.source.pageNumber).toBe(ATP.source.pageNumber);
    expect(concept.source.documentId).toBe(ATP.source.documentId);
    expect((input.item as { id: string }).id).toBe(ATP1.id);
    expect(input.answer).toBe(CORRECT_ATP);
  });

  it("the deterministic provider still grades identically through the new input", async () => {
    const p = new DeterministicProvider() as unknown as {
      gradeFreeAnswer: (input: unknown) => Promise<GradeResult>;
    };
    for (const answer of [CORRECT_ATP, WRONG, "Na/K ATPase", "?!"]) {
      expect(
        await p.gradeFreeAnswer({ concept: toGradeRequest(ATP, ATP1, answer).concept, item: ATP1, answer }),
      ).toEqual(gradeAnswer(ATP1, answer));
    }
  });
});

describe("M1: remediation is assembled from reviewed material, never provider prose", () => {
  const INVENTED = "Cyanide also uncouples oxidative phosphorylation, so give methylene blue.";

  it("an excerpt-quoting paragraph with invented medicine never reaches the learner", async () => {
    // Passes a naive "contains the excerpt" check.
    const smuggled = `"${ATP.source.excerpt}" ${INVENTED}`;
    const remediate = vi.fn(async () => smuggled);
    inject.provider = provider({ generateRemediation: remediate });

    const { status, body } = await grade(WRONG);
    expect(status).toBe(200);
    expect(JSON.stringify(body)).not.toContain(INVENTED);
    expect(body.remediation).toBe(await expectedRemediation(gradeAnswer(ATP1, WRONG)));
    // The provider is not even asked to write remediation.
    expect(remediate).not.toHaveBeenCalled();
  });

  it("a provider's 'missing' terms appear only if they are the item's own rubric terms", async () => {
    inject.provider = provider({
      gradeFreeAnswer: async () => ({
        outcome: "INCORRECT",
        correct: false,
        matched: [],
        missing: ["water", "give methylene blue immediately"],
        normalizedAnswer: "x",
      }),
    });
    const { status, body } = await grade(WRONG);
    expect(status).toBe(200);
    const remediation = body.remediation as string;
    expect(remediation).toContain("water");
    expect(remediation).not.toContain("methylene blue");
    expect(remediation).toContain(ATP.source.excerpt);
    expect(remediation).toContain(ATP1.explanation);
  });

  it("remediation is identical whichever provider graded", async () => {
    const reference = (await grade(WRONG)).body.remediation;
    inject.provider = provider({
      name: "stand-in",
      generateRemediation: async () => `${ATP.source.excerpt} ${INVENTED}`,
    });
    const other = (await grade(WRONG)).body.remediation;
    expect(other).toBe(reference);
  });
});
