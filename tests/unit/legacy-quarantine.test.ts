import { beforeEach, describe, expect, it } from "vitest";
import {
  applyOverrides,
  editConcept,
  migrateOverrides,
  setConceptStatus,
  type CurriculumOverrides,
} from "@/lib/domain/curriculum";
import {
  hasLegacyIdentities,
  legacyDocumentIds,
  quarantineLegacyLearnerState,
} from "@/lib/domain/quarantine";
import { pathologyCurriculum } from "@/lib/content/pathology";
import { createProgress } from "@/lib/domain/mastery";
import { newSchedule } from "@/lib/engine/scheduler";
import { buildTodayQueue } from "@/lib/engine/priority";
import { createLearnerState, isLectureUnlocked } from "@/lib/engine/tutor";
import {
  LocalStorageLearnerRepository,
  STORAGE_KEY,
  sanitizeLearnerState,
} from "@/lib/persistence/localStorage";
import {
  LEGACY_CHUNK,
  LEGACY_CONCEPTS,
  LEGACY_LECTURE,
  legacyV2Payload,
} from "./legacy-v2";
import type { LearnerState } from "@/lib/domain/types";

const T0 = new Date("2026-04-01T09:00:00.000Z");

function installFakeStorage() {
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
  return store;
}

/**
 * Learner state as it would exist after studying PDF A under the colliding
 * legacy identity: an edit, an approval, mastery, attempts, an FSRS schedule
 * and a completed chunk.
 */
function pdfALearnerState(): LearnerState {
  const base = createLearnerState();
  const schedule = newSchedule(T0);
  return {
    ...base,
    progress: {
      "legacy-c0": {
        ...createProgress("legacy-c0", schedule),
        mastery: "STRONG",
        totalAttempts: 7,
        totalCorrect: 7,
        consecutiveSpacedSuccesses: 3,
        lastAttemptAt: T0.toISOString(),
      },
      "legacy-c1": {
        ...createProgress("legacy-c1", schedule),
        mastery: "WEAK",
        totalAttempts: 2,
        everWrong: true,
      },
      // Authored Milestone 1 progress, whose ids never collided.
      "c-hypoxia": {
        ...createProgress("c-hypoxia", schedule),
        mastery: "STABLE",
        totalAttempts: 4,
        totalCorrect: 4,
        consecutiveSpacedSuccesses: 2,
      },
    },
    taughtChunkIds: [LEGACY_CHUNK.id, "chunk-ci-1"],
    completedChunkIds: [LEGACY_CHUNK.id, "chunk-ci-1"],
    completedLectureIds: [LEGACY_LECTURE],
    injectedByChunk: { [LEGACY_CHUNK.id]: ["legacy-c0"], "chunk-inf-1": ["c-hypoxia"] },
  };
}

function legacyOverrides(): CurriculumOverrides {
  const migrated = migrateOverrides(legacyV2Payload({ "legacy-c0": "ACTIVE" }));
  expect(migrated).not.toBeNull();
  return migrated!;
}

describe("legacy identity detection", () => {
  it("recognises the short colliding identity", () => {
    const overrides = legacyOverrides();
    expect(hasLegacyIdentities(overrides)).toBe(true);
    expect([...legacyDocumentIds(overrides)]).toContain("doc-lecture-811c9dc5");
  });

  it("a fresh SHA-256 identity is not treated as legacy", () => {
    const overrides = legacyOverrides();
    const modern = {
      ...overrides,
      ingested: overrides.ingested.map((entry) => ({
        ...entry,
        document: { ...entry.document, id: `doc-lecture-${"a".repeat(64)}` },
      })),
      concepts: overrides.concepts.map((c) => ({
        ...c,
        source: { ...c.source, documentId: `doc-lecture-${"a".repeat(64)}` },
      })),
    };
    expect(hasLegacyIdentities(modern)).toBe(false);
  });
});

describe("PDF B cannot inherit PDF A's legacy learner state", () => {
  let overrides: CurriculumOverrides;
  let result: ReturnType<typeof quarantineLegacyLearnerState>;

  beforeEach(() => {
    overrides = legacyOverrides();
    result = quarantineLegacyLearnerState(pdfALearnerState(), overrides);
  });

  it("drops mastery, attempts and schedule for the untrusted concepts", () => {
    for (const concept of LEGACY_CONCEPTS) {
      expect(result.learner.progress[concept.id], concept.id).toBeUndefined();
    }
    expect(result.quarantinedConceptIds).toHaveLength(LEGACY_CONCEPTS.length);
  });

  it("drops taught and completed state for the untrusted chunk", () => {
    expect(result.learner.taughtChunkIds).not.toContain(LEGACY_CHUNK.id);
    expect(result.learner.completedChunkIds).not.toContain(LEGACY_CHUNK.id);
    expect(result.learner.completedLectureIds).not.toContain(LEGACY_LECTURE);
  });

  it("drops interleaving bookkeeping for the untrusted material", () => {
    expect(result.learner.injectedByChunk[LEGACY_CHUNK.id]).toBeUndefined();
  });

  it("does not let a quarantined lecture keep anything unlocked", () => {
    const curriculum = applyOverrides(pathologyCurriculum, overrides);
    // The legacy lecture is ordered first, so a stale completion would have
    // unlocked everything after it.
    expect(result.learner.completedLectureIds).not.toContain(LEGACY_LECTURE);
    expect(isLectureUnlocked(curriculum, result.learner, "lecture-inflammation")).toBe(
      false,
    );
  });

  it("preserves authored Milestone 1 progress untouched", () => {
    const authored = result.learner.progress["c-hypoxia"];
    expect(authored).toBeDefined();
    expect(authored!.mastery).toBe("STABLE");
    expect(authored!.totalAttempts).toBe(4);
    expect(result.learner.taughtChunkIds).toContain("chunk-ci-1");
    expect(result.learner.completedChunkIds).toContain("chunk-ci-1");
    expect(result.learner.injectedByChunk["chunk-inf-1"]).toEqual(["c-hypoxia"]);
  });

  it("an old edit cannot resurface as approved content after re-review", () => {
    // PDF A's reviewer had edited the concept; migration returns it to DRAFT.
    const edited = editConcept(overrides, "legacy-c0", {
      summary: "Edited under the colliding identity.",
    });
    expect(edited.statusById["legacy-c0"]).toBe("DRAFT");

    // Re-approving is an explicit human act; until then nothing is teachable.
    const beforeReview = applyOverrides(pathologyCurriculum, edited);
    expect(
      beforeReview.concepts.find((c) => c.id === "legacy-c0")!.status,
    ).toBe("DRAFT");

    // And the learner history behind it is gone either way.
    const after = quarantineLegacyLearnerState(pdfALearnerState(), edited);
    expect(after.learner.progress["legacy-c0"]).toBeUndefined();
  });

  it("re-approved legacy material starts from zero, not from PDF A's mastery", () => {
    const reapproved = setConceptStatus(overrides, "legacy-c0", "ACTIVE");
    const curriculum = applyOverrides(pathologyCurriculum, reapproved);
    const quarantined = quarantineLegacyLearnerState(pdfALearnerState(), reapproved);

    expect(curriculum.concepts.find((c) => c.id === "legacy-c0")!.status).toBe("ACTIVE");
    expect(quarantined.learner.progress["legacy-c0"]).toBeUndefined();
    expect(
      buildTodayQueue(curriculum, quarantined.learner, T0).map((e) => e.concept.id),
    ).not.toContain("legacy-c0");
  });

  it("is a no-op when no legacy identity is present", () => {
    const clean = { ...legacyOverrides(), ingested: [], concepts: [] };
    const learner = pdfALearnerState();
    const untouched = quarantineLegacyLearnerState(learner, clean);
    expect(untouched.learner).toBe(learner);
    expect(untouched.quarantinedConceptIds).toEqual([]);
  });
});

describe("malformed learner state never reaches the engine", () => {
  beforeEach(() => {
    installFakeStorage();
  });

  it("drops a progress record whose schedule is missing", () => {
    const broken = {
      ...createLearnerState(),
      progress: {
        "c-hypoxia": { ...createProgress("c-hypoxia", newSchedule(T0)) },
        "c-atp-depletion": {
          ...createProgress("c-atp-depletion", newSchedule(T0)),
          schedule: undefined,
        },
      },
    };
    const result = sanitizeLearnerState(JSON.parse(JSON.stringify(broken)));
    expect(result).not.toBeNull();
    expect(result!.state.progress["c-hypoxia"]).toBeDefined();
    expect(result!.state.progress["c-atp-depletion"]).toBeUndefined();
    expect(result!.dropped).toEqual(["c-atp-depletion"]);
  });

  it("drops a record whose schedule.due is not a usable date", () => {
    const badDues: unknown[] = [undefined, null, "", "not-a-date", 12345];
    for (const due of badDues) {
      // Deliberately malformed, as a hand-edited or partially written store
      // would be; the cast is the point of the test.
      const broken = {
        ...createLearnerState(),
        progress: {
          "c-hypoxia": {
            ...createProgress("c-hypoxia", {
              ...newSchedule(T0),
              due: due as string,
            }),
          },
        },
      };
      const result = sanitizeLearnerState(JSON.parse(JSON.stringify(broken)));
      expect(result!.state.progress["c-hypoxia"], String(due)).toBeUndefined();
    }
  });

  it("Today survives a store that contained a malformed schedule", () => {
    const store = installFakeStorage();
    const broken = {
      ...createLearnerState(),
      progress: {
        "c-hypoxia": {
          ...createProgress("c-hypoxia", newSchedule(T0)),
          mastery: "WEAK",
          totalAttempts: 3,
        },
        "c-atp-depletion": {
          ...createProgress("c-atp-depletion", newSchedule(T0)),
          mastery: "WEAK",
          totalAttempts: 3,
          schedule: { reps: 1 },
        },
      },
    };
    store.set(STORAGE_KEY, JSON.stringify(broken));

    const loaded = new LocalStorageLearnerRepository().load();
    expect(loaded).not.toBeNull();

    // The engine runs, and the malformed record simply is not there.
    const queue = buildTodayQueue(pathologyCurriculum, loaded!, T0);
    expect(queue.map((e) => e.concept.id)).toContain("c-hypoxia");
    expect(queue.map((e) => e.concept.id)).not.toContain("c-atp-depletion");
    for (const entry of queue) {
      expect(Number.isNaN(new Date(entry.progress.schedule.due).getTime())).toBe(false);
    }
  });

  it("rejects the envelope when the container itself is wrong", () => {
    expect(sanitizeLearnerState(null)).toBeNull();
    expect(sanitizeLearnerState({ version: 1 })).toBeNull();
    expect(sanitizeLearnerState({ version: 1, progress: [] })).toBeNull();
    expect(
      sanitizeLearnerState({
        version: 1,
        progress: {},
        taughtChunkIds: [1],
        completedChunkIds: [],
        completedLectureIds: [],
        injectedByChunk: {},
      }),
    ).toBeNull();
  });

  it("keeps a completely valid store intact", () => {
    const valid = {
      ...createLearnerState(),
      progress: { "c-hypoxia": createProgress("c-hypoxia", newSchedule(T0)) },
    };
    const result = sanitizeLearnerState(JSON.parse(JSON.stringify(valid)));
    expect(result!.dropped).toEqual([]);
    expect(Object.keys(result!.state.progress)).toEqual(["c-hypoxia"]);
  });
});
