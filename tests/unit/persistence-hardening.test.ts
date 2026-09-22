import { beforeEach, describe, expect, it } from "vitest";
import {
  CURRICULUM_OVERRIDES_VERSION,
  migrateOverrides,
} from "@/lib/domain/curriculum";
import { acceptIncomingLearnerState } from "@/lib/domain/quarantine";
import {
  CURRICULUM_STORAGE_KEY,
  LocalStorageCurriculumRepository,
} from "@/lib/persistence/curriculumStore";
import { createLearnerState } from "@/lib/engine/tutor";
import { LEGACY_CHUNK, LEGACY_LECTURE, PDF_B_CONCEPTS, legacyV2Payload } from "./legacy-v2";
import type { LearnerState } from "@/lib/domain/types";

/** Records every write so "do not rewrite unnecessarily" can be asserted. */
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

function legacyOverrides() {
  return migrateOverrides(legacyV2Payload({ "legacy-c0": "ACTIVE" }))!;
}

/**
 * Legacy learner state with NO progress records at all — only chunk, lecture
 * and interleaving bookkeeping. This is the case that slipped through.
 */
function legacyStateWithoutProgress(): LearnerState {
  return {
    ...createLearnerState(),
    progress: {},
    taughtChunkIds: [LEGACY_CHUNK.id, "chunk-ci-1"],
    completedChunkIds: [LEGACY_CHUNK.id, "chunk-ci-1"],
    completedLectureIds: [LEGACY_LECTURE],
    injectedByChunk: { [LEGACY_CHUNK.id]: ["legacy-c0"], "chunk-inf-1": ["c-hypoxia"] },
  };
}

describe("quarantine reports a change even with no progress records", () => {
  it("removes legacy chunk, lecture and injected state", () => {
    const result = acceptIncomingLearnerState(
      legacyStateWithoutProgress(),
      legacyOverrides(),
    );
    expect(result.learner.taughtChunkIds).not.toContain(LEGACY_CHUNK.id);
    expect(result.learner.completedChunkIds).not.toContain(LEGACY_CHUNK.id);
    expect(result.learner.completedLectureIds).not.toContain(LEGACY_LECTURE);
    expect(result.learner.injectedByChunk[LEGACY_CHUNK.id]).toBeUndefined();
  });

  it("reports that something changed, so the caller knows to persist", () => {
    const result = acceptIncomingLearnerState(
      legacyStateWithoutProgress(),
      legacyOverrides(),
    );
    // No progress records existed, so the concept list is empty...
    expect(result.quarantinedConceptIds).toEqual([]);
    // ...but unsafe state WAS removed and must not be silently dropped.
    expect(result.quarantinedChunkIds.length).toBeGreaterThan(0);
    expect(result.quarantinedLectureIds).toContain(LEGACY_LECTURE);
    expect(result.changed).toBe(true);
  });

  it("preserves authored Milestone 1 bookkeeping", () => {
    const result = acceptIncomingLearnerState(
      legacyStateWithoutProgress(),
      legacyOverrides(),
    );
    expect(result.learner.taughtChunkIds).toContain("chunk-ci-1");
    expect(result.learner.completedChunkIds).toContain("chunk-ci-1");
    expect(result.learner.injectedByChunk["chunk-inf-1"]).toEqual(["c-hypoxia"]);
  });

  it("reports no change for state that is already clean", () => {
    const overrides = legacyOverrides();
    const once = acceptIncomingLearnerState(legacyStateWithoutProgress(), overrides);
    const twice = acceptIncomingLearnerState(once.learner, overrides);
    expect(twice.changed).toBe(false);
    expect(twice.learner).toEqual(once.learner);
  });

  it("reports no change when there are no legacy identities at all", () => {
    const clean = { ...legacyOverrides(), ingested: [], concepts: [] };
    const result = acceptIncomingLearnerState(legacyStateWithoutProgress(), clean);
    expect(result.changed).toBe(false);
  });
});

describe("curriculum migration is written back to storage", () => {
  beforeEach(() => {
    installFakeStorage();
  });

  /** A real v3 payload: ACTIVE and DISCARDED legacy decisions, plus an edit. */
  function v3Payload() {
    return legacyV2Payload(
      { "legacy-c0": "ACTIVE", "legacy-c1": "DISCARDED", "c-draft-lysosomal": "ACTIVE" },
      {
        version: 3,
        edits: {
          "legacy-c0": { title: "EDIT FROM PDF A", summary: "SUMMARY FROM PDF A" },
          "c-hypoxia": { title: "Authored edit worth keeping" },
        },
        concepts: PDF_B_CONCEPTS,
      },
    );
  }

  it("returns a migrated value at the current version", () => {
    const { store } = installFakeStorage();
    store.set(CURRICULUM_STORAGE_KEY, JSON.stringify(v3Payload()));

    const loaded = new LocalStorageCurriculumRepository().load()!;
    expect(loaded.version).toBe(CURRICULUM_OVERRIDES_VERSION);
    expect(loaded.statusById["legacy-c0"]).toBe("DRAFT");
    expect(loaded.statusById["legacy-c1"]).toBe("DRAFT");
    expect(loaded.edits["legacy-c0"]).toBeUndefined();
  });

  it("writes the cleaned payload back, so the unsafe one does not sit on disk", () => {
    const { store } = installFakeStorage();
    store.set(CURRICULUM_STORAGE_KEY, JSON.stringify(v3Payload()));

    new LocalStorageCurriculumRepository().load();

    const raw = store.get(CURRICULUM_STORAGE_KEY)!;
    const onDisk = JSON.parse(raw);
    expect(onDisk.version).toBe(CURRICULUM_OVERRIDES_VERSION);
    expect(onDisk.statusById["legacy-c0"]).toBe("DRAFT");
    expect(onDisk.statusById["legacy-c1"]).toBe("DRAFT");
    expect(onDisk.edits["legacy-c0"]).toBeUndefined();
    expect(raw).not.toContain("EDIT FROM PDF A");
    expect(raw).not.toContain("SUMMARY FROM PDF A");
  });

  it("preserves authored Milestone 1 decisions and edits on disk", () => {
    const { store } = installFakeStorage();
    store.set(CURRICULUM_STORAGE_KEY, JSON.stringify(v3Payload()));

    new LocalStorageCurriculumRepository().load();

    const onDisk = JSON.parse(store.get(CURRICULUM_STORAGE_KEY)!);
    expect(onDisk.statusById["c-draft-lysosomal"]).toBe("ACTIVE");
    expect(onDisk.edits["c-hypoxia"]).toEqual({ title: "Authored edit worth keeping" });
  });

  it("is idempotent: a second load returns the same value", () => {
    const { store } = installFakeStorage();
    store.set(CURRICULUM_STORAGE_KEY, JSON.stringify(v3Payload()));

    const repo = new LocalStorageCurriculumRepository();
    const first = repo.load()!;
    const second = repo.load()!;
    expect(second).toEqual(first);
  });

  it("does not rewrite storage when the payload is already current", () => {
    const { store, writes } = installFakeStorage();
    const current = migrateOverrides(v3Payload())!;
    store.set(CURRICULUM_STORAGE_KEY, JSON.stringify(current));
    writes.length = 0;

    new LocalStorageCurriculumRepository().load();
    expect(writes).toEqual([]);
  });

  it("still returns a safe value when writing back fails", () => {
    const store = new Map<string, string>();
    store.set(CURRICULUM_STORAGE_KEY, JSON.stringify(v3Payload()));
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
        removeItem: (k: string) => void store.delete(k),
      },
    };

    const loaded = new LocalStorageCurriculumRepository().load()!;
    expect(loaded.version).toBe(CURRICULUM_OVERRIDES_VERSION);
    expect(loaded.statusById["legacy-c0"]).toBe("DRAFT");
    expect(loaded.edits["legacy-c0"]).toBeUndefined();
  });

  it("returns null for an unreadable payload without writing anything", () => {
    const { store, writes } = installFakeStorage();
    store.set(CURRICULUM_STORAGE_KEY, "{not json");
    writes.length = 0;
    expect(new LocalStorageCurriculumRepository().load()).toBeNull();
    expect(writes).toEqual([]);
  });
});
