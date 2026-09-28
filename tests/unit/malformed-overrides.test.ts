import { beforeEach, describe, expect, it } from "vitest";
import { pathologyCurriculum as C } from "@/lib/content/pathology";
import {
  applyOverrides,
  editConcept,
  migrateOverrides,
  sanitizeOverrides,
  setConceptStatus,
  type CurriculumOverrides,
} from "@/lib/domain/curriculum";
import type { Concept, SourceRef } from "@/lib/domain/types";
import { createLearnerState, getNextStep, markChunkTaught, recordAttempt } from "@/lib/engine/tutor";
import {
  CURRICULUM_STORAGE_KEY,
  LocalStorageCurriculumRepository,
  commitOverrides,
} from "@/lib/persistence/curriculumStore";
import { driveLecture } from "./driver";
import { ANSWERS } from "./helpers";
import { CHUNK, DOC, DUP, HYPOXIA, L1, L2, OTHER, T0, dup, other, withUpload } from "./duplicate-fixture";

/**
 * M1 — malformed persisted merge state is isolated, never fatal.
 *
 * One bad `merges` entry used to make the repository reject the ENTIRE
 * curriculum: every uploaded document vanished from the app and the next
 * save replaced the store with a fresh one. Validation is now record-local:
 * a malformed entry is dropped on its own and everything valid loads.
 * Derived concept fields (`mergedInto`, `additionalSources`) are sanitised
 * before they can reach the Tutor or Study.
 */

function installFakeStorage() {
  const store = new Map<string, string>();
  const writes: string[] = [];
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        writes.push(k);
        store.set(k, v);
      },
      removeItem: (k: string) => void store.delete(k),
    },
  };
  return { store, writes };
}

const OTHER_DOC_SOURCE: SourceRef = { courseId: "course-pathology", lectureId: L2, documentId: `${DOC}-x`, pageNumber: 2, excerpt: "Also stated in the summary deck." };
const valid = (): CurriculumOverrides => setConceptStatus(withUpload(), OTHER, "ACTIVE");
const stored = (patch: Record<string, unknown>) => ({ ...JSON.parse(JSON.stringify(valid())), ...patch }) as unknown;
const withConcept = (concept: unknown) => stored({ concepts: [JSON.parse(JSON.stringify(dup)), concept] });
const conceptIn = (o: CurriculumOverrides, id: string) => applyOverrides(C, o).concepts.find((c) => c.id === id);
/** A learner who has finished Lecture 1, so Lecture 2 (the handout's) is unlocked. */
const unlocked = () => driveLecture(createLearnerState(), L1, T0).learner;

describe("M1: malformed merge state is isolated, never fatal", () => {
  it("M1-A: one malformed merges entry does not reject the curriculum — documents, concepts and decisions remain", () => {
    const loaded = migrateOverrides(stored({ merges: { [DUP]: 42 } }));
    expect(loaded).not.toBeNull();
    expect(loaded!.ingested.map((i) => i.document.id)).toEqual([DOC]);
    expect(loaded!.concepts.map((c) => c.id)).toEqual([DUP, OTHER]);
    expect(loaded!.statusById[OTHER]).toBe("ACTIVE");
    expect(loaded!.merges).toEqual({});
    expect(conceptIn(loaded!, DUP)!.status).toBe("DRAFT");
    expect(sanitizeOverrides(stored({ merges: { [DUP]: 42 } }))!.dropped).toEqual([`merges.${DUP}`]);
  });

  it("M1-B: two valid merge entries survive next to one malformed one; the same holds for keptApart", () => {
    const loaded = migrateOverrides(stored({
      merges: { [DUP]: HYPOXIA, [OTHER]: "c-chemotaxis", bad: null },
      keptApart: { [DUP]: "c-atp-depletion", "": "x", self: "self", empty: "" },
    }))!;
    expect(loaded.merges).toEqual({ [DUP]: HYPOXIA, [OTHER]: "c-chemotaxis" });
    expect(loaded.keptApart).toEqual({ [DUP]: "c-atp-depletion" });
    expect(conceptIn(loaded, DUP)!.mergedInto).toBe(HYPOXIA);
    // A container of the wrong type is treated as empty, not as a reason to reject everything.
    expect(migrateOverrides(stored({ merges: "nope" }))!.merges).toEqual({});
    expect(migrateOverrides(stored({ merges: ["a"] }))!.ingested).toHaveLength(1);
  });

  it("M1-C: a stored concept keeps its valid additional source, loses the malformed one, and TEACH does not throw", () => {
    const loaded = migrateOverrides(withConcept({
      ...JSON.parse(JSON.stringify(other)),
      additionalSources: [OTHER_DOC_SOURCE, { documentId: 5 }, null, "text", { ...OTHER_DOC_SOURCE, pageNumber: 0 }],
    }))!;
    const composed = conceptIn(loaded, OTHER)!;
    expect(composed.additionalSources).toEqual([OTHER_DOC_SOURCE]);

    const curriculum = applyOverrides(C, loaded);
    let learner = unlocked();
    for (let i = 0; i < 40; i++) {
      const step = getNextStep(curriculum, learner, L2, T0);
      if (step.kind === "TEACH" && step.chunk.id === CHUNK) {
        expect(step.pages.map((p) => p.text).join("\n")).toContain("Neutrophils are the first cells");
        return;
      }
      if (step.kind === "TEACH") {
        learner = markChunkTaught(curriculum, learner, step.chunk.id);
        continue;
      }
      if (step.kind === "LECTURE_COMPLETE" || step.kind === "AWAITING_APPROVAL") throw new Error(`unexpected ${step.kind}`);
      learner = recordAttempt(curriculum, learner, { conceptId: step.concept.id, itemId: step.item.id, answer: ANSWERS[step.concept.id] ?? "Neutrophils", context: step.context, chunkId: step.chunk.id, now: T0 }).learner;
    }
    throw new Error("handout chunk never taught");
  });

  it("M1-C: a non-array additionalSources is dropped as a whole, and TEACH still runs", () => {
    for (const additionalSources of [5, "text", { documentId: DOC }, null]) {
      const loaded = migrateOverrides(withConcept({ ...JSON.parse(JSON.stringify(other)), additionalSources }))!;
      expect(loaded).not.toBeNull();
      expect(conceptIn(loaded, OTHER)!.additionalSources).toBeUndefined();
      expect(() => getNextStep(applyOverrides(C, loaded), unlocked(), L2, T0)).not.toThrow();
    }
  });

  it("M1-D: a malformed or unexplained mergedInto is stripped — never an ACTIVE escalation, never a rejection", () => {
    for (const mergedInto of [42, "", {}, [], null, HYPOXIA]) {
      const loaded = migrateOverrides(withConcept({ ...JSON.parse(JSON.stringify(dup)), id: OTHER, mergedInto }))!;
      expect(loaded).not.toBeNull();
      const composed = conceptIn(loaded, OTHER)!;
      expect(composed.mergedInto).toBeUndefined();
      expect(composed.status).toBe("ACTIVE"); // the stored decision for OTHER, not an escalation by recovery
      expect(loaded.concepts.find((c) => c.id === OTHER)).not.toHaveProperty("mergedInto");
    }
    // A concept whose stored status is DRAFT stays DRAFT through recovery.
    const draft = migrateOverrides(stored({ statusById: {}, concepts: [JSON.parse(JSON.stringify(dup)), { ...JSON.parse(JSON.stringify(other)), mergedInto: 7 }] }))!;
    expect(conceptIn(draft, OTHER)!.status).toBe("DRAFT");
    // The merge map remains the only source of "merged".
    const merged = migrateOverrides(stored({ merges: { [DUP]: HYPOXIA }, concepts: [{ ...JSON.parse(JSON.stringify(dup)), mergedInto: "elsewhere" }, JSON.parse(JSON.stringify(other))] }))!;
    expect(conceptIn(merged, DUP)!.mergedInto).toBe(HYPOXIA);
    expect(conceptIn(merged, DUP)!.status).toBe("DISCARDED");
  });

  describe("through the repository", () => {
    let storage: ReturnType<typeof installFakeStorage>;
    beforeEach(() => {
      storage = installFakeStorage();
    });

    it("M1-A: the store loads, the sanitised version is written back once, and the document stays", () => {
      storage.store.set(CURRICULUM_STORAGE_KEY, JSON.stringify(stored({ merges: { [DUP]: 42, [OTHER]: "c-chemotaxis" } })));
      const repo = new LocalStorageCurriculumRepository();
      const loaded = repo.load()!;
      expect(loaded.ingested.map((i) => i.document.id)).toEqual([DOC]);
      expect(loaded.merges).toEqual({ [OTHER]: "c-chemotaxis" });
      expect(storage.writes).toEqual([CURRICULUM_STORAGE_KEY]);
      // Clean now: a second load rewrites nothing.
      expect(new LocalStorageCurriculumRepository().load()!.merges).toEqual({ [OTHER]: "c-chemotaxis" });
      expect(storage.writes).toEqual([CURRICULUM_STORAGE_KEY]);
    });

    it("M1-E: load malformed state, save an unrelated change, reload — nothing valid was lost", () => {
      storage.store.set(CURRICULUM_STORAGE_KEY, JSON.stringify(stored({
        merges: { [DUP]: HYPOXIA, junk: 1 },
        concepts: [JSON.parse(JSON.stringify(dup)), { ...JSON.parse(JSON.stringify(other)), additionalSources: [null, OTHER_DOC_SOURCE], mergedInto: 9 }],
      })));
      const repo = new LocalStorageCurriculumRepository();
      const loaded = repo.load()!;
      const { saved } = commitOverrides(repo, loaded, (o) => editConcept(o, OTHER, { title: "Neutrophils (edited after recovery)" }));
      expect(saved).toBe(true);

      const reloaded = new LocalStorageCurriculumRepository().load()!;
      expect(reloaded.ingested.map((i) => i.document.id)).toEqual([DOC]);
      expect(reloaded.concepts.map((c) => c.id)).toEqual([DUP, OTHER]);
      expect(reloaded.merges).toEqual({ [DUP]: HYPOXIA });
      expect(reloaded.statusById).toMatchObject({ [OTHER]: "ACTIVE" });
      const composed = applyOverrides(C, reloaded);
      expect(composed.concepts.find((c) => c.id === OTHER)!.title).toBe("Neutrophils (edited after recovery)");
      expect(composed.concepts.find((c) => c.id === DUP)!.status).toBe("DISCARDED");
      expect(composed.concepts.find((c) => c.id === OTHER)!.additionalSources).toEqual([OTHER_DOC_SOURCE]);
      expect(composed.course.lectures.find((l) => l.id === L2)!.documents.some((d) => d.id === DOC)).toBe(true);
      expect(() => getNextStep(composed, unlocked(), L2, T0)).not.toThrow();
    });
  });

  it("stored concepts never carry derived fields after sanitisation", () => {
    const loaded = migrateOverrides(withConcept({ ...JSON.parse(JSON.stringify(other)), additionalSources: [OTHER_DOC_SOURCE], mergedInto: HYPOXIA }))!;
    const concept = loaded.concepts.find((c) => c.id === OTHER) as Concept;
    expect(concept.mergedInto).toBeUndefined();
    expect(concept.additionalSources).toEqual([OTHER_DOC_SOURCE]);
  });
});
